import { chromium } from "playwright";
const b = await chromium.launch(); const p = await b.newPage();
await p.setContent("<div id=x class='a b'>hi</div>");
const h = await p.$("#x");
// (1) no named inner functions:
const r1 = await h!.evaluate((node) => {
  const e = node as Element;
  let n = 1; let sib = e.previousElementSibling;
  while (sib) { n++; sib = sib.previousElementSibling; }
  return e.tagName.toLowerCase() + ":" + n;
});
console.log("inline-only:", r1);
// (2) function declaration inner:
const r2 = await h!.evaluate((node) => {
  function lc(s: string) { return s.toLowerCase(); }
  return lc((node as Element).tagName);
});
console.log("func-decl:", r2);
await b.close();
