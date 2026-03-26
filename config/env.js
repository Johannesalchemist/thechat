import dotenv from "dotenv";
dotenv.config();

export const TELEGRAM_TOKEN  = process.env.TELEGRAM_TOKEN;
export const ANTHROPIC_KEY   = process.env.ANTHROPIC_KEY;
export const NYXA_API        = process.env.NYXA_API || "http://localhost:3000";
