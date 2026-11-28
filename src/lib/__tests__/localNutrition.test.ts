import { describe, expect, it } from 'vitest';
import { FOOD_CATALOG } from '../../data/localFoods';
import { analyzeLocalFood } from '../localNutrition';

describe('bundled local nutrition reference', () => {
  it('retains the source counts and unique food identifiers', () => {
    expect(FOOD_CATALOG).toHaveLength(461);
    expect(FOOD_CATALOG.reduce((n,row)=>n+row[9].length,0)).toBe(1335);
    expect(new Set(FOOD_CATALOG.map(row=>row[0])).size).toBe(461);
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