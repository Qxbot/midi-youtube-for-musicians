import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

export type VideoResult = {
  id: string;
  title: string;
  channel: string;
  duration: string;
  views: string;
  thumbnail: string;
};

function collect(node: unknown, out: VideoResult[]) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const n of node) collect(n, out);
    return;
  }
  const obj = node as Record<string, any>;
  if (obj.videoRenderer?.videoId) {
    const v = obj.videoRenderer;
    out.push({
      id: v.videoId,
      title: v.title?.runs?.map((r: any) => r.text).join("") ?? "",
      channel: v.ownerText?.runs?.[0]?.text ?? "",
      duration: v.lengthText?.simpleText ?? "LIVE",
      views: v.shortViewCountText?.simpleText ?? v.viewCountText?.simpleText ?? "",
      thumbnail: `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`,
    });
    return;
  }
  for (const k in obj) collect(obj[k], out);
}

export const searchYouTube = createServerFn({ method: "POST" })
  .inputValidator((input) => z.object({ q: z.string().min(1).max(200) }).parse(input))
  .handler(async ({ data }) => {
    const res = await fetch(
      `https://www.youtube.com/results?search_query=${encodeURIComponent(data.q)}&hl=en&gl=US`,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
          "Accept-Language": "en-US,en;q=0.9",
          Cookie: "CONSENT=YES+1",
        },
      },
    );
    const html = await res.text();
    const m = html.match(/var ytInitialData\s*=\s*(\{.+?\});<\/script>/s);
    if (!m) return { results: [] as VideoResult[] };
    const out: VideoResult[] = [];
    try {
      collect(JSON.parse(m[1]), out);
    } catch {
      return { results: [] as VideoResult[] };
    }
    const seen = new Set<string>();
    return { results: out.filter((v) => !seen.has(v.id) && seen.add(v.id)).slice(0, 40) };
  });
