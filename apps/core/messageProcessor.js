export async function processMessage(text) {
  if (text === "/start") {
    return "Welcome to The Chat.";
  }

  if (text === "/help") {
    return "Commands: /start /help";
  }

  return "You said: " + text;
}
