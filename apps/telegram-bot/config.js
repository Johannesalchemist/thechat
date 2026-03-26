import dotenv from "dotenv";
dotenv.config();

export const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;

export const TELEGRAM_API =
  "https://api.telegram.org/bot" + TELEGRAM_TOKEN;
