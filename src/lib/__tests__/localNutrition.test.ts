import { describe, expect, it } from 'vitest';
import { FOOD_CATALOG } from '../../data/localFoods';
import { analyzeLocalFood, searchLocalFoods } from '../localNutrition';

describe('bundled local nutrition reference', () => {
  it('retains the source counts and unique food identifiers', () => {
    expect(FOOD_CATALOG).toHaveLength(1061);
    expect(FOOD_CATALOG.reduce((n,row)=>n+row[9].length,0)).toBe(1335);
    expect(new Set(FOOD_CATALOG.map(row=>row[0])).size).toBe(1061);
  });
  it('calculates two cooked foods using their actual USDA reference values', () => {
    const result=analyzeLocalFood('150g cooked chicken breast and 100g cooked rice');
    expect(result.questions).toEqual([]);
    expect(result.items.map(i=>[i.sourceId,i.grams,i.kcal,i.protein,i.state])).toEqual([
      ['171477',150,248,46.5,'cooked'],['168878',100,130,2.7,'cooked']
    ]);
    expect(result.items[0].fat).toBe(5.4);
    expect(result.items[1].carbs).toBe(28.2);
  });
  it('recognizes Persian digits and selected Persian food names', () => {
    const result=analyzeLocalFood('۱۵۰ گرم سینه مرغ پخته و ۱۰۰ گرم برنج پخته');
    expect(result.items.map(i=>i.kcal)).toEqual([248,130]);
    expect(result.questions).toEqual([]);
  });
  it('distinguishes raw and cooked rice and normalizes weight units', () => {
    expect(analyzeLocalFood('100 g raw rice').items[0].kcal).toBe(365);
    expect(analyzeLocalFood('0.1 kg cooked rice').items[0]).toMatchObject({grams:100,kcal:130,unit:'g',quantity:100});
    expect(analyzeLocalFood('cooked rice 100 grams').items[0].kcal).toBe(130);
  });
  it('never invents values for unmatched foods or ambiguous preparation', () => {
    for (const description of ['100g rice','100g chicken breast','150g unavailable food','200g ghormeh sabzi']) {
      const result=analyzeLocalFood(description);
      expect(result.items[0]).toMatchObject({kcal:null,protein:null,source:'generic',sourceId:null});
      expect(result.questions.length).toBeGreaterThan(0);
    }
  });
  it('retains unknown weight as null rather than defaulting to a serving', () => {
    const result=analyzeLocalFood('banana');
    expect(result.items[0]).toMatchObject({grams:null,kcal:null,protein:null});
    expect(result.questions.length).toBeGreaterThan(0);
  });
  it('rejects ambiguous numeric formats and unsafe ranges', () => {
    for (const input of ['1,000 g banana','100-200g banana','-150g banana']) {
      const result=analyzeLocalFood(input);
      expect(result.items).toEqual([]);
      expect(result.questions.length).toBeGreaterThan(0);
    }
  });
  it('keeps invalid or oversized portions unknown and limits meal size', () => {
    expect(analyzeLocalFood('6000g banana').items[0].grams).toBeNull();
    expect(analyzeLocalFood('0g banana').items[0].kcal).toBeNull();
    expect(analyzeLocalFood(Array(21).fill('100g banana').join(';')).items).toEqual([]);
  });
  it('uses source household portions only when unambiguous', () => {
    const row=FOOD_CATALOG.find(row=>row[0]==='olive-oil')!;
    const match=row[9].find(([label])=>label.toLowerCase()==='1 tablespoon')!;
    expect(match).toBeDefined();
    expect(analyzeLocalFood('1 tbsp olive oil').items[0].grams).toBe(match[1]);
  });
});
describe('reference integrity and safe matching', () => {
  it('calculates every catalog row from its explicit FDC identifier at five exact weights', () => {
    for(const row of FOOD_CATALOG) {
      for(const g of [1,37,100,150,5000]) {
        const result=analyzeLocalFood(g+' g fdc:'+row[2]);
        expect(result.questions, row[2]).toEqual([]);
        expect(result.items).toHaveLength(1);
        const item=result.items[0];
        expect(item.sourceId).toBe(row[2]);
        expect(item.grams).toBe(g);
        expect(item.kcal).toBe(row[5]===null?null:Math.round(row[5]*g/100));
        for(const [value,index] of [[item.protein,6],[item.fat,7],[item.carbs,8]] as const) {
          const n=row[index] as number|null;
          expect(value).toBe(n===null?null:Math.round(n*g/100*10)/10);
        }
      }
    }
  });
  it('validates unique source IDs, nonnegative nutrients and plausible macro mass', () => {
    expect(new Set(FOOD_CATALOG.map(r=>r[2])).size).toBe(FOOD_CATALOG.length);
    for(const row of FOOD_CATALOG) {
      expect(row[2]).toMatch(/^\d+$/);
      for(const v of row.slice(5,9)) if(v!==null) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
      }
      expect((row[5]??0)).toBeLessThanOrEqual(1000);
      expect((row[6]??0)+(row[7]??0)+(row[8]??0)).toBeLessThanOrEqual(105);
      for(const [label,g] of row[9]) {
        expect(label.trim()).not.toBe('');
        expect(Number.isFinite(g)&&g>0).toBe(true);
      }
    }
  });
  it('rejects generic preparation and suggests explicit reference choices', () => {
    for(const q of ['salmon','shrimp','tuna','lentils','pasta','ground beef']) {
      expect(analyzeLocalFood('100g '+q).items[0].kcal).toBeNull();
      expect(searchLocalFoods(q).length).toBeGreaterThan(0);
    }
    expect(searchLocalFoods('rice').some(r=>r[0]==='white-rice-raw')).toBe(true);
    expect(analyzeLocalFood('100 g fdc:999999999').items[0].kcal).toBeNull();
  });
  it('does not split named compound dishes or assume a missing quantity', () => {
    const result=analyzeLocalFood('100 g beef and broccoli');
    expect(result.items).toHaveLength(1);
    expect(result.items[0].sourceId).toBe(FOOD_CATALOG.find(r=>r[0]==='beef-and-broccoli')![2]);
    expect(analyzeLocalFood('100g banana and rice').items[0].kcal).toBeNull();
  });
  it('handles explicit fractions, Persian quantities and cooked dry-heat references', () => {
    expect(analyzeLocalFood('1/2 cup cooked rice').items[0].grams).toBe(79);
    expect(analyzeLocalFood('.5 kg cooked rice').items[0].grams).toBe(500);
    expect(analyzeLocalFood('100g fdc:'+FOOD_CATALOG.find(r=>r[0]==='cod')![2]).items[0].state).toBe('cooked');
    expect(analyzeLocalFood('۱۰۰ گرم عدس پخته').items[0].kcal).toBe(116);
  });
});
it('requires explicit selection for expanded records and preserves exact source identity', () => {
  const row=FOOD_CATALOG.find(r=>r[0]==='fdc-167512')!;
  expect(row).toBeDefined();
  expect(analyzeLocalFood('100 g '+row[1]).items.every(i=>i.sourceId!==row[2])).toBe(true);
  expect(analyzeLocalFood('100 g fdc:'+row[2]).items[0]).toMatchObject({sourceId:row[2],kcal:307});
});
