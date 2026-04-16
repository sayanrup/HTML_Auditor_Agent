import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { nanoid } from "nanoid";

export type FeedbackEntry = {
  id: string;
  message: string;
  createdAt: string;
};

const dataDir =
  process.env.FEEDBACK_DATA_DIR?.trim() || join(process.cwd(), "data");
const feedbackFile = join(dataDir, "feedback.json");

let mutex: Promise<unknown> = Promise.resolve();

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = mutex.then(() => fn());
  mutex = run.then(() => undefined).catch(() => undefined);
  return run;
}

async function readAllUnsafe(): Promise<FeedbackEntry[]> {
  try {
    const raw = await readFile(feedbackFile, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (row): row is FeedbackEntry =>
        typeof row === "object" &&
        row !== null &&
        typeof (row as FeedbackEntry).id === "string" &&
        typeof (row as FeedbackEntry).message === "string" &&
        typeof (row as FeedbackEntry).createdAt === "string"
    );
  } catch {
    return [];
  }
}

export async function listFeedback(): Promise<FeedbackEntry[]> {
  return withLock(async () => {
    const rows = await readAllUnsafe();
    return rows.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  });
}

export async function addFeedback(message: string): Promise<FeedbackEntry> {
  return withLock(async () => {
    await mkdir(dirname(feedbackFile), { recursive: true });
    const rows = await readAllUnsafe();
    const entry: FeedbackEntry = {
      id: nanoid(),
      message: message.trim(),
      createdAt: new Date().toISOString(),
    };
    rows.push(entry);
    await writeFile(feedbackFile, JSON.stringify(rows, null, 2), "utf-8");
    return entry;
  });
}
