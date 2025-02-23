const express = require("express");
const cors = require("cors");
const pg = require("pg");
const fs = require("fs");
const path = require("path");
const { speak } = require("google-translate-api-x");
const dotenv = require("dotenv");

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const pool = new pg.Pool({
  host: process.env.PG_HOST,
  port: process.env.PG_PORT,
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  database: process.env.PG_DATABASE,
});

pool
  .connect()
  .then((client) => {
    console.log("Подключение к базе данных успешно");
    client.release();
  })
  .catch((err) => {
    console.error("Ошибка подключения к базе данных:", err);
  });

const INTERVALS = [
  20 * 60 * 1000,
  2 * 60 * 60 * 1000,
  1 * 24 * 60 * 60 * 1000,
  2 * 24 * 60 * 60 * 1000,
  7 * 24 * 60 * 60 * 1000,
  14 * 24 * 60 * 60 * 1000,
  30 * 24 * 60 * 60 * 1000
];

app.post("/words", async (req, res) => {
  const { text } = req.body;

  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line);

  const words = lines
    .map((line) => {
      const match = line.match(/^([\p{Script=Latin}\d\s'’!?-]+?)\s([\p{Script=Cyrillic}\d\s.,;!?()-]+.*)$/u);
      if (!match) return null;

      return {
        term: match[1].trim(),
        translation: match[2].trim(),
      };
    })
    .filter(Boolean);

  for (let word of words) {
    try {
      // Генерация аудио для термина на французском языке
      const audioBuffer = await speak(word.term, { to: "fr" });

      const audioFileName = `${word.term.replace(/\s+/g, "_")}.mp3`;
      const audioFilePath = path.join(__dirname, "audio", audioFileName);

      fs.writeFileSync(audioFilePath, audioBuffer, { encoding: "base64" });

      await pool.query("INSERT INTO words (term, translation, audio_url, next_review) VALUES ($1, $2, $3, NOW())", [
        word.term,
        word.translation,
        `/audio/${audioFileName}`,
      ]);
    } catch (error) {
      console.error(`Ошибка при обработке слова "${word.term}":`, error);
    }
  }

  res.json({ success: true });
});

// Обслуживание статических файлов
app.use("/audio", express.static(path.join(__dirname, "audio")));

// Получение слова для тренировки
app.get("/train", async (req, res) => {
  const { rows } = await pool.query(
    "SELECT * FROM words WHERE next_review <= NOW() AND status != 'Know' ORDER BY RANDOM() LIMIT 1"
  );
  res.json(rows[0] || null);
});

// Обновление статуса слова
app.post("/update", async (req, res) => {
  const { id, action } = req.body;
  const { rows } = await pool.query("SELECT * FROM words WHERE id = $1", [id]);
  const word = rows[0];

  if (!word) return res.status(404).json({ error: "Слово не найдено" });

  let nextReview;
  let newInterval = word.interval;

  if (action === "know") {
    
    if (newInterval <= INTERVALS.length - 1) {
      
      nextReview = new Date(Date.now() + INTERVALS[newInterval]);
      newInterval += 1;
      
    } else {
      await pool.query("UPDATE words SET status = 'Know' WHERE id = $1", [id]);
      return res.json({ success: true });
    }
  } else if (action === "study") {
    newInterval = 0; // Сброс, если не знаем слово
    nextReview = new Date();
  }

  await pool.query("UPDATE words SET next_review = $1, interval = $2 WHERE id = $3", [nextReview, newInterval, id]);
  res.json({ success: true });
});

app.listen(process.env.PORT, () => console.log(`Сервер запущен на порту ${process.env.PORT}`));
