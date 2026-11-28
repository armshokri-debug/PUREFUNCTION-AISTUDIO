import { FOOD_CATALOG, type FoodRow } from '../data/localFoods';

export interface LocalEstimate {
  name: string; quantity: number; unit: string; grams: number | null; state: string;
  kcal: number | null; protein: number | null; fat: number | null; carbs: number | null;
  source: 'USDA' | 'generic' | 'manual'; sourceId: string | null;
  assumptions: string; version: string; kcalPerGram: number | null; proteinPerGram: number | null;
}
const normalize = (s: string) => s.normalize('NFKC').toLowerCase()
  .replace(/[۰-۹]/g, c => String(c.charCodeAt(0) - 1776))
  .replace(/[٠-٩]/g, c => String(c.charCodeAt(0) - 1632))
  .replace(/ي/g,'ی').replace(/ك/g,'ک').replace(/[\u200c\u200d]/g,' ')
  .replace(/[-–]/g,' ').replace(/\s+/g,' ').trim();
const rows = new Map(FOOD_CATALOG.map(row => [row[0], row]));
const names = new Map<string, FoodRow[]>();
for (const row of FOOD_CATALOG) {
  for (const name of new Set([normalize(row[0]),normalize(row[1])])) {
    const existing = names.get(name) ?? [];
    names.set(name,[...existing,row]);
  }
}
const aliases: Record<string,string> = {
  'cooked chicken breast':'chicken-breast-roasted','roasted chicken breast':'chicken-breast-roasted',
  'raw chicken breast':'chicken-breast','سینه مرغ پخته':'chicken-breast-roasted','سینه مرغ خام':'chicken-breast',
  'cooked rice':'white-rice','cooked white rice':'white-rice','raw rice':'white-rice-raw','raw white rice':'white-rice-raw',
  'برنج پخته':'white-rice','برنج سفید پخته':'white-rice','برنج خام':'white-rice-raw',
  'cooked brown rice':'brown-rice','raw brown rice':'brown-rice-raw',
  'banana':'banana','bananas':'banana','موز':'banana','apples':'apple','سیب':'apple',
  'boiled egg':'hard-boiled-egg','boiled eggs':'hard-boiled-egg','hard boiled eggs':'hard-boiled-egg',
  'تخم مرغ آب پز':'hard-boiled-egg','egg':'eggs','raw egg':'eggs','raw eggs':'eggs',
  'olive oil':'olive-oil','روغن زیتون':'olive-oil','whole milk':'whole-milk','شیر پرچرب':'whole-milk',
  'plain whole milk yogurt':'plain-yogurt','plain low fat yogurt':'low-fat-yogurt',
  'dry oats':'oatmeal','جو دوسر خشک':'oatmeal','boiled potatoes':'boiled-potato','سیب زمینی آب پز':'boiled-potato',
  'almond':'almonds','بادام':'almonds','خیار':'cucumber','گوجه فرنگی':'tomato','پرتقال':'orange'
};
const ambiguous = new Set(['rice','white rice','brown rice','chicken','chicken breast','برنج','مرغ','سینه مرغ','milk','yogurt','plain yogurt','شیر','ماست','oats','oatmeal','potato','سیب زمینی','egg','eggs','تخم مرغ']);
const canonicalUnit = (unit: string): string => {
  if (/^(kg|kilograms?|کیلوگرم)$/.test(unit)) return 'kg';
  if (/^(g|grams?|گرم)$/.test(unit)) return 'g';
  if (/^(oz|ounces?)$/.test(unit)) return 'oz';
  if (/^(cups?|پیمانه|فنجان)$/.test(unit)) return 'cup';
  if (/^(tbsp|tablespoons?|قاشق غذاخوری)$/.test(unit)) return 'tbsp';
  if (/^(pieces?|عدد)$/.test(unit)) return 'piece';
  return 'serving';
};
const amount = '(\\d+(?:\\.\\d+)?|\\d+\\s*/\\s*\\d+)';
const units = '(kilograms?|kg|grams?|g|ounces?|oz|cups?|tablespoons?|tbsp|pieces?|servings?|کیلوگرم|گرم|پیمانه|فنجان|قاشق غذاخوری|عدد)';
const leading = new RegExp('^'+amount+'\\s*'+units+'\\s+(.+)$','u');
const trailing = new RegExp('^(.+?)\\s+'+amount+'\\s*'+units+'$','u');
const pieces = new RegExp('^'+amount+'\\s+(.+)$','u');
const numeric = (s: string) => { const parts = s.split('/').map(Number); return parts.length===2 ? parts[0]/parts[1] : parts[0]; };
function portion(text: string): { food:string; quantity:number; unit:string; explicit:boolean } {
  const start=text.match(leading);
  const end=text.match(trailing);
  const piece=text.match(pieces);
  if (start) return {food:start[3],quantity:numeric(start[1]),unit:canonicalUnit(start[2]),explicit:true};
  if (end) return {food:end[1],quantity:numeric(end[2]),unit:canonicalUnit(end[3]),explicit:true};
  if (piece) return {food:piece[2],quantity:numeric(piece[1]),unit:'piece',explicit:true};
  return {food:text,quantity:1,unit:'serving',explicit:false};
}
function stateOf(row: FoodRow): string {
  const d=normalize(row[3]);
  if (/\b(raw|uncooked|dry)\b/.test(d)) return 'raw';
  if (/\b(cooked|roasted|boiled|baked|grilled|fried|steamed)\b/.test(d)) return 'cooked';
  return 'unknown';
}
function gramsFor(row:FoodRow, quantity:number, unit:string):number|null {
  if (unit==='g') return quantity;
  if (unit==='kg') return quantity*1000;
  if (unit==='oz') return quantity*28.349523125;
  // Only use an unqualified, exact household measure from the source.
  const allowed = unit==='cup' ? ['1 cup'] : unit==='tbsp' ? ['1 tbsp','1 tablespoon'] : unit==='piece' ? ['1 piece','1 item'] : ['1 serving'];
  const matches = [...new Set(row[9].filter(([label])=>allowed.includes(normalize(label))).map(([,g])=>g))];
  return matches.length===1 ? quantity*matches[0] : null;
}
function round(x:number, decimals:number):number {const m=10**decimals; return Math.round(x*m)/m;}
function nutrient(per100:number|null, grams:number|null, precision:number):number|null {
  return per100===null||grams===null ? null : round(per100*grams/100,precision);
}
export function analyzeLocalFood(description:string):{items:LocalEstimate[];questions:string[]} {
  if (!description.trim()||description.length>2000) return {items:[],questions:['Enter a food description of up to 2000 characters.']};
  // A negative weight must never be normalized into a positive amount.
  if (/(?:^|[\s;,،؛+])[-−]\s*[0-9۰-۹٠-٩]/u.test(description)) return {items:[],questions:['Use a positive weight for every food.']};
  const text=normalize(description.replace(/\r?\n/g,';'));
  // Do not silently split or guess locale-dependent numeric commas or ranges.
  if (/\d,\d|\d\s*[-–]\s*\d/.test(description.replace(/[۰-۹]/g,c=>String(c.charCodeAt(0)-1776)).replace(/[٠-٩]/g,c=>String(c.charCodeAt(0)-1632)))) {
    return {items:[],questions:['Use a decimal point and one exact amount per food (e.g. 150 g).']};
  }
  const segments=text.split(/\s*(?:;|,|[+؛،]|\band\b| و )\s*/u).filter(Boolean);
  if (segments.length>20) return {items:[],questions:['Analyze at most 20 foods at a time.']};
  const items:LocalEstimate[]=[]; const questions:string[]=[];
  for (const part of segments) {
    const p=portion(part); const food=normalize(p.food);
    const validQuantity=Number.isFinite(p.quantity)&&p.quantity>0&&p.quantity<100000;
    const candidates=names.get(food)??[];
    const row=ambiguous.has(food)?undefined:rows.get(aliases[food]??'')??(candidates.length===1?candidates[0]:undefined);
    let grams:number|null=null;
    if (p.explicit&&validQuantity) {
      grams=row?gramsFor(row,p.quantity,p.unit):p.unit==='g'?p.quantity:p.unit==='kg'?p.quantity*1000:p.unit==='oz'?p.quantity*28.349523125:null;
      if (grams!==null&&(!Number.isFinite(grams)||grams<=0||grams>5000)) grams=null;
    }
    const label=food.slice(0,200)||part.slice(0,200);
    if (!row) questions.push(ambiguous.has(food)?'Specify preparation or type for "'+label+'", e.g. cooked or raw, or enter values manually.':'No exact local match for "'+label+'". Specify ingredients or enter label values manually.');
    if (grams===null) questions.push('Specify a weight in grams for "'+label+'".');
    const kcalPerGram=row&&row[5]!==null?row[5]/100:null;
    const proteinPerGram=row&&row[6]!==null?row[6]/100:null;
    items.push({name:row?row[1]:label,quantity:validQuantity?(p.unit==='kg'&&grams!==null?grams:p.quantity):1,unit:p.unit==='kg'?(grams!==null?'g':'serving'):p.unit,
      grams,state:row?stateOf(row):'unknown',kcal:row?nutrient(row[5],grams,0):null,protein:row?nutrient(row[6],grams,1):null,
      fat:row?nutrient(row[7],grams,1):null,carbs:row?nutrient(row[8],grams,1):null,
      source:row?'USDA':'generic',sourceId:row?row[2]:null,
      assumptions:row?'USDA reference: '+row[3]+'. '+(grams===null?'Weight not confirmed.':'Values are estimates; added oils, sauces and brands may differ.'): 'Unmatched food; no nutrient values inferred.',
      version:'local-food-2026-11-18',kcalPerGram,proteinPerGram});
  }
  return {items,questions};
}
