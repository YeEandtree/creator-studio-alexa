// Normalise everything the page can be translated through, so the UI is always
// English no matter what language the browser or the OS is set to.
import fs from "node:fs";
import path from "node:path";

const pub = path.resolve("public");

function read(p) {
  return fs.readFileSync(path.join(pub, p), "utf8");
}
function write(p, s) {
  fs.writeFileSync(path.join(pub, p), s, "utf8");
}

// index.html -------------------------------------------------------------
let html = read("index.html");
if (!/translate="no"/.test(html)) {
  html = html.replace('<html lang="en">', '<html lang="en" translate="no" class="notranslate">');
}
if (!/Content-Language/.test(html)) {
  html = html.replace('<meta charset="utf-8" />', '<meta charset="utf-8" />\n<meta http-equiv="Content-Language" content="en" />');
}
if (!/name="google"/.test(html)) {
  html = html.replace('<meta charset="utf-8" />', '<meta charset="utf-8" />\n<meta name="google" content="notranslate" />');
}
write("index.html", html);

// app.js: force the recognition + speech languages to English -------------
let js = read("app.js");
js = js.replace(
  /recognition\.lang\s*=\s*navigator\.language\.startsWith\("zh"\)\s*\?\s*"zh-CN"\s*:\s*"en-US";/,
  'recognition.lang = "en-US"; // the demo is English-only; a zh locale would split words badly',
);
if (!/utterance\.lang/.test(js)) {
  js = js.replace(
    /const u = new SpeechSynthesisUtterance\(text\);/,
    'const u = new SpeechSynthesisUtterance(text);\n  u.lang = "en-US";\n  u.voice = speechSynthesis.getVoices().find((v) => /en-US|en_GB|en-GB/.test(v.lang)) ?? null;',
  );
}
write("app.js", js);

console.log("pages normalised to English");
