"""Read-only reference audit and expansion candidate from pinned USDA releases.

No credentials, runtime calls, repository writes, or production data.
The expanded candidate is an artifact for review, never auto-published.
"""
import hashlib
import io
import json
import math
import pathlib
import urllib.request
import zipfile
from collections import Counter

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / "nutrition-audit"
SOURCES = {
    "FoodData Central SR Legacy 2018-04": ("sr_legacy_food_json_2018-04", "SRLegacyFoods"),
    "FoodData Central FNDDS (Survey Foods) 2024-10-31": ("survey_food_json_2024-10-31", "SurveyFoods"),
    "FoodData Central Foundation Foods 2026-04-30": ("foundation_food_json_2026-04-30", "FoundationFoods"),
}
BASE = "https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_"
MAX_ZIP = 32 * 1024 * 1024
MAX_JSON = 300 * 1024 * 1024

def download(suffix, key):
    url = BASE + suffix + ".zip"
    req = urllib.request.Request(url, headers={"User-Agent": "PureFunction-reference-audit/1.0"})
    with urllib.request.urlopen(req, timeout=90) as response:
        if not response.geturl().startswith("https://fdc.nal.usda.gov/"):
            raise ValueError("Unexpected download origin")
        blob = response.read(MAX_ZIP + 1)
    if len(blob) > MAX_ZIP:
        raise ValueError("USDA archive exceeded size limit")
    with zipfile.ZipFile(io.BytesIO(blob)) as archive:
        members = [i for i in archive.infolist() if i.filename.lower().endswith(".json")]
        if len(members) != 1 or members[0].file_size > MAX_JSON:
            raise ValueError("Unexpected USDA JSON archive")
        with archive.open(members[0]) as handle:
            data = json.load(handle)
    foods = data[key]
    if not isinstance(foods, list) or not foods:
        raise ValueError("Empty USDA source")
    by_id = {str(f["fdcId"]): f for f in foods}
    if len(by_id) != len(foods):
        raise ValueError("Duplicate official FDC ID")
    return by_id, {"url": url, "sha256": hashlib.sha256(blob).hexdigest(), "foods": len(foods)}

def nutrients(food):
    result = {}
    for n in food.get("foodNutrients", []):
        nutrient_id = n.get("nutrient", {}).get("id", n.get("nutrientId"))
        amount = n.get("amount")
        if isinstance(amount, (int, float)) and math.isfinite(amount) and amount >= 0:
            result.setdefault(nutrient_id, set()).add(amount)
    return result

def unique(n, key):
    values = n.get(key, set())
    return next(iter(values)) if len(values) == 1 else None

def macros(food):
    n = nutrients(food)
    # Never synthesize kcal with a heuristic formula. Use documented USDA energy.
    energy = next((unique(n, k) for k in (1008, 2048, 2047) if unique(n, k) is not None), None)
    return [energy, unique(n, 1003), unique(n, 1004), unique(n, 1005)]

def close(a, b):
    return a is None and b is None or a is not None and b is not None and abs(a-b) <= 0.000001

def main():
    OUT.mkdir(exist_ok=True)
    rows = [json.loads(line.rstrip(",")) for line in (ROOT / "src/data/localFoods.ts").read_text().splitlines() if line.startswith('["')]
    report = {"catalog_count":len(rows), "release_archives":{}, "mismatches":[], "portion_weight_matches":0, "portion_weight_unverified":[], "verified_foods":0, "expanded_candidate_count":0}
    candidate = []
    existing_ids = {row[2] for row in rows}
    for release,(suffix,key) in SOURCES.items():
        foods, provenance = download(suffix,key)
        report["release_archives"][release] = provenance
        for row in (r for r in rows if r[4]==release):
            food = foods.get(row[2])
            if food is None:
                report["mismatches"].append({"fdc_id":row[2],"reason":"missing id"})
                continue
            official = macros(food)
            # Compare all four nutrients, not only energy or a spot check.
            description_match = food.get("description") == row[3]
            if not description_match or not all(close(a,b) for a,b in zip(row[5:9], official)):
                report["mismatches"].append({"fdc_id":row[2],"description_match":description_match,"bundled":row[5:9],"official":official})
            else:
                report["verified_foods"] += 1
            weights = [p.get("gramWeight") for p in food.get("foodPortions",[]) if isinstance(p.get("gramWeight"),(int,float))]
            for label, grams in row[9]:
                if any(close(grams,w) for w in weights):
                    report["portion_weight_matches"] += 1
                else:
                    report["portion_weight_unverified"].append({"fdc_id":row[2],"label":label,"grams":grams})
        for id,food in foods.items():
            if id in existing_ids:
                continue
            values=macros(food)
            description=food.get("description","").strip()
            if not description or len(description)>200 or any(v is None for v in values):
                continue
            if values[0]>1000 or any(v>100 for v in values[1:]) or sum(values[1:])>105:
                continue
            # Add exact, searchable official descriptions only. No guessed aliases or portions.
            candidate.append(["fdc-"+id,description,id,description,release,*values,[]])
            existing_ids.add(id)
        print(f"{release}: {len(foods)} official entries, verified current rows so far {report['verified_foods']}", flush=True)
        del foods
    report["expanded_candidate_count"] = len(candidate)
    report["catalog_release_counts"] = dict(Counter(row[4] for row in rows))
    (OUT / "report.json").write_text(json.dumps(report,ensure_ascii=False,indent=2))
    (OUT / "expanded-candidate.json").write_text(json.dumps(candidate,ensure_ascii=False,separators=(",",":")))
    print(json.dumps({k:v for k,v in report.items() if k not in ("mismatches","portion_weight_unverified")},ensure_ascii=False))
    print("MISMATCH COUNT:",len(report["mismatches"]),"PORTION WEIGHTS UNVERIFIED:",len(report["portion_weight_unverified"]))
    for mismatch in report["mismatches"]:
        print("MISMATCH:",json.dumps(mismatch,ensure_ascii=False))
    if report["verified_foods"]!=len(rows) or report["portion_weight_unverified"]:
        raise SystemExit("Official reference audit requires review; no candidate is auto-published.")
    print("PASS: all catalog descriptions, four nutrients and portion weights matched. Portion label semantics require separate review.")

if __name__ == "__main__":
    main()
