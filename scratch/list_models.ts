import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
dotenv.config();

const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_GEMINI_API_KEY! });

async function listModels() {
  try {
    const result = await ai.models.list();

    for await (const m of result) {
      if (m.supportedActions?.includes('generateContent')) {
        console.log(m.name);
      }
    }
  } catch (err) {
    console.error("Error listing models:", err);
  }
}

listModels();
