import * as OpenCC from "opencc-js";

// Character-level display variants derived from OpenCC/Unicode Hans-to-Hant mappings.
// Values contain traditional alternatives only; the source character is always shown first.
// Keep at most two alternatives so the final display contains no more than three forms.
export const traditionalVariants = Object.freeze({
  "万": ["萬"], "东": ["東"], "为": ["為"], "举": ["舉"], "义": ["義"],
  "乡": ["鄉"], "于": ["於"], "云": ["雲"], "仪": ["儀"], "体": ["體"],
  "党": ["黨"], "兴": ["興"], "军": ["軍"], "县": ["縣"], "后": ["後"],
  "响": ["響"], "国": ["國"], "图": ["圖"], "圣": ["聖"], "声": ["聲"],
  "宁": ["寧", "甯"], "实": ["實"], "将": ["將"], "尘": ["塵"], "尽": ["盡", "儘"],
  "岁": ["歲"], "岂": ["豈"], "干": ["乾", "幹"], "庐": ["廬"], "当": ["當", "噹"],
  "征": ["徵"], "怀": ["懷"], "据": ["據"], "无": ["無"], "旷": ["曠"],
  "晖": ["暉"], "术": ["術"], "来": ["來"], "杨": ["楊"], "松": ["鬆"],
  "极": ["極"], "汤": ["湯"], "灯": ["燈"], "灵": ["靈"], "礼": ["禮"],
  "笃": ["篤"], "终": ["終"], "经": ["經"], "绝": ["絕"], "继": ["繼"],
  "绳": ["繩"], "缅": ["緬"], "腊": ["臘"], "苍": ["蒼"], "袭": ["襲"],
  "识": ["識"], "试": ["試"], "谯": ["譙"], "贞": ["貞"], "贤": ["賢"],
  "质": ["質"], "贻": ["貽"], "贼": ["賊"], "资": ["資"], "赵": ["趙"],
  "轨": ["軌"], "迈": ["邁"], "邺": ["鄴"], "钦": ["欽"], "长": ["長"],
  "阙": ["闕"], "阳": ["陽"], "际": ["際"], "陈": ["陳"], "难": ["難"],
  "韵": ["韻"], "风": ["風"], "鲁": ["魯"], "台": ["臺", "檯"],
});

const simplifiedToTraditional = OpenCC.Converter({ from: "cn", to: "tw" });

function defaultTraditionalVariant(character) {
  return traditionalVariants[character]?.[0] ?? simplifiedToTraditional(character);
}

export function candidateDisplayCharacter(character) {
  const forms = [character, ...(traditionalVariants[character] ?? [simplifiedToTraditional(character)])];
  return [...new Set(forms)].slice(0, 3).join("/");
}

function isIdsExpression(value) {
  return value.includes("⿰") || value.includes("⿱") || value.includes("⿲") || value.includes("⿳")
    || value.includes("⿴") || value.includes("⿵") || value.includes("⿶") || value.includes("⿷")
    || value.includes("⿸") || value.includes("⿹") || value.includes("⿺") || value.includes("⿻");
}

// Display-only conversion. The stored hypothesis remains unchanged.
// Multi-character input uses one default traditional form per character.
export function userInputDisplayCharacter(value) {
  if (!value || isIdsExpression(value)) return value;
  const characters = Array.from(value);
  if (characters.length === 1) return candidateDisplayCharacter(characters[0]);
  return characters.map(defaultTraditionalVariant).join("");
}

