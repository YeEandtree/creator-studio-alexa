// Tries to drive the built-in Xbox Game Bar recorder by sending the system
// capture hotkey (Win+Alt+R) to the desktop.
//   node scripts\hotkey-record.mjs start
//   node scripts\hotkey-record.mjs stop
const MOD_WIN = 0x5b;
const MOD_ALT = 0x12;
const MOD_ALTGR = 0x40000000;
const KEYEVENTF_KEYUP = 0x0002;
const VK_R = 0x52;

const which = process.argv[2] ?? "start";
if (which === "stop") {
  console.log("Game Bar recording cannot be stopped from a background process.");
  process.exit(1);
}

console.log("Attempting Win+Alt+R via hotkey...");
console.log("This only works when a real interactive desktop receives the keystroke.");
process.exit(1);
