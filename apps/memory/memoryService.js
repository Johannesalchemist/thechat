import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(__dirname, "memoryStore.json");

export function loadMemory() {
  const data = fs.readFileSync(file, "utf-8");
  return JSON.parse(data);
}

export function saveMemory(memory) {
  fs.writeFileSync(file, JSON.stringify(memory, null, 2));
}

export function appendMessage(user, text) {
  const memory = loadMemory();
  if (!memory[user]) memory[user] = [];
  memory[user].push(text);
  saveMemory(memory);
}

export function getHistory(user) {
  const memory = loadMemory();
  return memory[user] || [];
}
