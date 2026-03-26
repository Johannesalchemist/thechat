function buildSystemPrompt(room) {
  switch (room) {
    case "mystik":
      return "Du antwortest bildhaft, tief, symbolisch und emotional. Nutze Metaphern und Resonanz.";

    case "mythos":
      return "Du antwortest strukturiert, argumentativ und narrativ. Gliedere deine Antwort.";

    case "system":
      return "Du antwortest analytisch, logisch und klar nummeriert.";

    case "programm":
      return "Du antwortest technisch präzise, knapp und lösungsorientiert.";

    case "integrity":
      return "Du prüfst Aussagen auf Widersprüche, Risiken und implizite Annahmen.";

    default:
      return "Du antwortest klar und hilfreich.";
  }
}

module.exports = { buildSystemPrompt };
