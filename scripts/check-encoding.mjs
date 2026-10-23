// Validate that the served page has no stray bytes: reads every public/*.html,
// *.css, *.js plus the JSON API responses and reports invalid UTF-8.
import fs from "node:fs";
import path from "node:path";

const pub = path.resolve("public");
const files = fs.readdirSync(pub).filter((f) => /\.(html|css|js|json)$/.test(f));
let problems = 0;

for (const f of files) {
  const buf = fs.readFileSync(path.join(pub, f));
  const text = new TextDecoder("utf-8", { fatal: false }).decode(buf);
  const replacement = [...text].filter((c) => c === "\uFFFD").length;
  const cjk = [...text].filter((c) => /[\u4e00-\u9fa5]/.test(c)).length;
  console.log(`${f.padEnd(14)} bytes=${String(buf.length).padStart(6)}  bad=${replacement}  cjk=${cjk}`);
  if (replacement || cjk) {
    problems += 1;
    const idx = text.indexOf("\uFFFD");
    if (idx >= 0) console.log("   first bad char near:", JSON.stringify(text.slice(Math.max(0, idx - 40), idx + 40)));
    const cj = text.match(/[\u4e00-\u9fa5]+/g);
    if (cj) console.log("   cjk found:", cj.slice(0, 8).join(" "));
  }
}
console.log(problems ? `PROBLEMS: ${problems}` : "clean: all files are valid UTF-8 with no CJK text");
