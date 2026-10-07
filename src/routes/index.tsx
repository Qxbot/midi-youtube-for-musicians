import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { searchYouTube, type VideoResult } from "@/lib/youtube-search.functions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Heart, Settings2 } from "lucide-react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Midi YouTube for Musicians" },
      { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
      { name: "description", content: "Control YouTube playback with any USB MIDI controller: play, cue points, seek, volume and speed." },
      { property: "og:title", content: "Midi YouTube for Musicians" },
      { property: "og:description", content: "Practice with YouTube hands-free using your MIDI controller." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
    links: [
      { rel: "icon", href: "/app-icon.png", type: "image/png" },
      { rel: "apple-touch-icon", href: "/app-icon.png" },
      { rel: "manifest", href: "/manifest.webmanifest" },
    ],
  }),
  component: App,
});

/* ---------- types & storage ---------- */
type ActionId =
  | "playPause" | "goto"
  | "forward" | "back" | "volUp" | "volDown" | "speedUp" | "speedDown";

const ACTIONS: { id: ActionId; label: string }[] = [
  { id: "playPause", label: "Play / Pause" },
  { id: "goto", label: "Go to" },
  { id: "forward", label: "Forward" },
  { id: "back", label: "Back" },
  { id: "volUp", label: "Volume +10%" },
  { id: "volDown", label: "Volume −10%" },
  { id: "speedUp", label: "Speed +25%" },
  { id: "speedDown", label: "Speed −25%" },
];

type Settings = {
  mappings: Partial<Record<ActionId, string>>;
  cues: { goto: { m: number; s: number } };
  seekStep: number;
  volume: number;
  speed: number;
  autoFullscreen: boolean;
};
type Favorite = { id: string; title: string; goto: { m: number; s: number } };
type Saved = {
  settings: Settings;
  lastQuery: string;
  lastResults: VideoResult[];
  lastVideo: { id: string; title: string; time: number } | null;
  favorites: Favorite[];
};
const KEY = "midi-yt-musicians-v1";
const DEFAULTS: Saved = {
  settings: {
    mappings: {},
    cues: { goto: { m: 0, s: 0 } },
    seekStep: 5,
    volume: 80,
    speed: 1,
    autoFullscreen: true,
  },
  lastQuery: "",
  lastResults: [],
  lastVideo: null,
  favorites: [],
};
function load(): Saved {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    const p = JSON.parse(raw);
    const settings: Settings = { ...DEFAULTS.settings, ...p.settings };
    // migrate: old multi-cue "Go to" (goto1..goto4) -> single "goto"
    const cues = { ...(p.settings?.cues ?? {}) } as Record<string, { m: number; s: number } | undefined>;
    for (const old of ["goto1", "goto2", "goto3", "goto4"]) {
      if (cues[old]) { cues["goto"] = cues[old]; delete cues[old]; }
    }
    if (!cues["goto"]) cues["goto"] = { m: 0, s: 0 };
    settings.cues = cues as Settings["cues"];
    const maps = { ...(p.settings?.mappings ?? {}) } as Record<string, string | undefined>;
    for (const old of ["goto1", "goto2", "goto3", "goto4"]) {
      if (maps[old]) { maps["goto"] = maps[old]; delete maps[old]; }
    }
    settings.mappings = maps as Settings["mappings"];
    return { ...DEFAULTS, ...p, settings, favorites: Array.isArray(p.favorites) ? p.favorites : [] };
  } catch {
    return DEFAULTS;
  }
}

const fmt = (t: number) => {
  t = Math.max(0, Math.floor(t || 0));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return (h ? `${h}:${String(m).padStart(2, "0")}` : `${m}`) + `:${String(s).padStart(2, "0")}`;
};

declare global {
  interface Window { YT: any; onYouTubeIframeAPIReady?: () => void }
}

function loadYT(): Promise<any> {
  if (!document.getElementById("yt-api")) {
    const sc = document.createElement("script");
    sc.id = "yt-api";
    sc.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(sc);
  }
  return new Promise((resolve) => {
    const check = () => (window.YT?.Player ? resolve(window.YT) : setTimeout(check, 100));
    check();
  });
}

/* ---------- App ---------- */
function App() {
  const [ready, setReady] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [state, setState] = useState<Saved>(DEFAULTS);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => { setState(load()); setReady(true); }, []);
  useEffect(() => { if (ready) localStorage.setItem(KEY, JSON.stringify(state)); }, [state, ready]);

  const setSettings = (fn: (s: Settings) => Settings) =>
    setState((p) => ({ ...p, settings: fn(p.settings) }));

  const setGoto = (goto: { m: number; s: number }) => {
    setState((p) => {
      const lastVideoId = p.lastVideo?.id;
      return {
        ...p,
        settings: { ...p.settings, cues: { ...p.settings.cues, goto } },
        favorites: lastVideoId
          ? p.favorites.map((f) => f.id === lastVideoId ? { ...f, goto: { ...goto } } : f)
          : p.favorites,
      };
    });
  };

  /* player */
  const playerRef = useRef<any>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [overlay, setOverlay] = useState<{ text: string; key: number } | null>(null);
  const overlayTimer = useRef<number | undefined>(undefined);

  const flash = useCallback((text: string) => {
    setOverlay({ text, key: Date.now() });
    window.clearTimeout(overlayTimer.current);
    overlayTimer.current = window.setTimeout(() => setOverlay(null), 2000);
  }, []);

  const killCaptions = () => {
    const p = playerRef.current;
    try { p?.unloadModule?.("captions"); p?.unloadModule?.("cc"); p?.setOption?.("captions", "track", {}); } catch {}
  };

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    loadYT().then((YT) => {
      if (cancelled || !hostRef.current) return;
      hostRef.current.innerHTML = "";
      const el = document.createElement("div");
      hostRef.current.appendChild(el);
      const lv = stateRef.current.lastVideo;
      playerRef.current = new YT.Player(el, {
        width: "100%", height: "100%",
        ...(lv ? { videoId: lv.id } : {}),
        playerVars: {
          controls: 0, rel: 0, modestbranding: 1, iv_load_policy: 3, disablekb: 1,
          fs: 0, playsinline: 1, cc_load_policy: 0, autoplay: 1, origin: window.location.origin,
          start: lv ? Math.floor(lv.time) : 0,
        },
        events: {
          onReady: (e: any) => {
            const s = stateRef.current.settings;
            e.target.setVolume(s.volume);
            e.target.setPlaybackRate(s.speed);
            killCaptions();
            if (lv) e.target.playVideo();
          },
          onStateChange: (e: any) => {
            setPlaying(e.data === 1);
            if (e.data === 1) { killCaptions(); e.target.setPlaybackRate(stateRef.current.settings.speed); }
          },
          onApiChange: killCaptions,
        },
      });
    });
    return () => { cancelled = true; try { playerRef.current?.destroy?.(); } catch {} playerRef.current = null; };
  }, [ready]);

  // poll progress; save position; stop before end-screen suggestions
  useEffect(() => {
    const iv = window.setInterval(() => {
      const p = playerRef.current;
      if (!p?.getCurrentTime) return;
      const t = p.getCurrentTime(), d = p.getDuration();
      setTime(t); setDuration(d);
      if (d > 0 && t > d - 0.4 && p.getPlayerState() === 1) { p.pauseVideo(); p.seekTo(d - 0.5, true); }
    }, 250);
    const sv = window.setInterval(() => {
      const p = playerRef.current;
      if (!p?.getCurrentTime) return;
      setState((s) => (s.lastVideo ? { ...s, lastVideo: { ...s.lastVideo, time: p.getCurrentTime() } } : s));
    }, 3000);
    return () => { clearInterval(iv); clearInterval(sv); };
  }, []);

  const playVideo = (v: VideoResult, startSeconds = 0) => {
    setState((s) => ({ ...s, lastVideo: { id: v.id, title: v.title, time: startSeconds } }));
    playerRef.current?.loadVideoById?.({ videoId: v.id, startSeconds });
  };

  const toggleFavorite = () => {
    const video = stateRef.current.lastVideo;
    if (!video) return;
    const c = stateRef.current.settings.cues.goto ?? { m: 0, s: 0 };
    const favorite: Favorite = { id: video.id, title: video.title, goto: { m: c.m, s: c.s } };
    const exists = stateRef.current.favorites.some((f) => f.id === video.id);
    setState((s) => ({ ...s, favorites: exists ? s.favorites.filter((f) => f.id !== video.id) : [favorite, ...s.favorites] }));
    flash(exists ? "♡  Removed from favorites" : "♥  Added to favorites");
  };

  const openFavorite = (f: Favorite) => {
    const start = f.goto.m * 60 + f.goto.s;
    setState((s) => ({ ...s, lastVideo: { id: f.id, title: f.title, time: start } }));
    playerRef.current?.loadVideoById?.({ videoId: f.id, startSeconds: start });
    setSettingsOpen(false);
  };

  /* actions */
  const runAction = useCallback((id: ActionId) => {
    const p = playerRef.current;
    if (!p?.getPlayerState) return;
    const s = stateRef.current.settings;
    const t = p.getCurrentTime();
    switch (id) {
      case "playPause":
        if (p.getPlayerState() === 1) { p.pauseVideo(); flash("❚❚  Pause"); }
        else { p.playVideo(); flash("▶  Play"); }
        break;
      case "goto": {
        const c = s.cues.goto ?? { m: 0, s: 0 }; const target = c.m * 60 + c.s;
        p.seekTo(target, true); flash(`⤓  Go to ${fmt(target)}`); break;
      }
      case "forward": p.seekTo(Math.min(t + s.seekStep, p.getDuration()), true); flash(`»  +${s.seekStep}s`); break;
      case "back": p.seekTo(Math.max(t - s.seekStep, 0), true); flash(`«  −${s.seekStep}s`); break;
      case "volUp": case "volDown": {
        const v = Math.max(0, Math.min(100, s.volume + (id === "volUp" ? 10 : -10)));
        p.setVolume(v); if (v > 0) p.unMute();
        setSettings((x) => ({ ...x, volume: v })); flash(`🔊  Volume ${v}%`); break;
      }
      case "speedUp": case "speedDown": {
        const r = Math.max(0.25, Math.min(2, s.speed + (id === "speedUp" ? 0.25 : -0.25)));
        p.setPlaybackRate(r); setSettings((x) => ({ ...x, speed: r })); flash(`⏱  Speed ${r}x`); break;
      }
    }
  }, [flash]);

  /* MIDI */
  const [midiStatus, setMidiStatus] = useState("Connecting…");
  const [devices, setDevices] = useState<string[]>([]);
  const [learning, setLearning] = useState<ActionId | null>(null);
  const learningRef = useRef(learning);
  learningRef.current = learning;
  const [lastMsg, setLastMsg] = useState("");

  useEffect(() => {
    if (!ready) return;
    const nav = navigator as any;
    if (!nav.requestMIDIAccess) { setMidiStatus("Web MIDI not supported in this browser (use Chrome or Edge)"); return; }
    let access: any;
    const onMsg = (e: any) => {
      const [st = 0, d1 = 0, d2 = 0] = e.data as Uint8Array;
      const type = st & 0xf0, ch = (st & 0x0f) + 1;
      let key: string | null = null;
      if (type === 0x90 && d2 > 0) key = `note:${ch}:${d1}`;
      else if (type === 0xb0 && d2 > 0) key = `cc:${ch}:${d1}`;
      else if (type === 0xc0) key = `pc:${ch}:${d1}`;
      if (!key) return;
      setLastMsg(key.replace(/:/, " ch").replace(/:/, " #"));
      const l = learningRef.current;
      if (l) {
        setSettings((s) => {
          const m = { ...s.mappings };
          for (const k in m) if (m[k as ActionId] === key) delete m[k as ActionId];
          m[l] = key!;
          return { ...s, mappings: m };
        });
        setLearning(null);
        flash(`Learned: ${ACTIONS.find((a) => a.id === l)?.label}`);
        return;
      }
      const maps = stateRef.current.settings.mappings;
      const act = (Object.keys(maps) as ActionId[]).find((k) => maps[k] === key);
      if (act) runAction(act);
    };
    const bind = () => {
      const names: string[] = [];
      access.inputs.forEach((i: any) => { i.onmidimessage = onMsg; names.push(i.name); });
      setDevices(names);
      setMidiStatus(names.length ? "Connected" : "No MIDI device found – plug in a controller");
    };
    nav.requestMIDIAccess().then((a: any) => { access = a; bind(); a.onstatechange = bind; },
      () => setMidiStatus("MIDI access denied"));
    return () => { access?.inputs.forEach((i: any) => (i.onmidimessage = null)); };
  }, [ready, runAction, flash]);

  /* fullscreen */
  const [isFs, setIsFs] = useState(false);
  const toggleFs = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else stageRef.current?.requestFullscreen?.().catch(() => {});
  };
  useEffect(() => {
    const h = () => setIsFs(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", h);
    return () => document.removeEventListener("fullscreenchange", h);
  }, []);
  useEffect(() => {
    if (!ready || !state.settings.autoFullscreen) return;
    const external = (window.screen as any).isExtended || /DeX/i.test(navigator.userAgent) ||
      (window.screen.width >= 1600 && matchMedia("(pointer: fine)").matches);
    if (!external) return;
    const go = () => { if (!document.fullscreenElement) stageRef.current?.requestFullscreen?.().catch(() => {}); };
    go(); // browsers may require a first click/key; fall back below
    const once = () => { go(); cleanup(); };
    const cleanup = () => { window.removeEventListener("pointerdown", once); window.removeEventListener("keydown", once); };
    window.addEventListener("pointerdown", once); window.addEventListener("keydown", once);
    return cleanup;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  /* search */
  const [query, setQuery] = useState("");
  useEffect(() => { if (ready) setQuery(state.lastQuery); /* eslint-disable-next-line */ }, [ready]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const doSearch = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const q = query.trim(); if (!q) return;
    setSearching(true);
    try {
      const { results } = await searchYouTube({ data: { q } });
      setState((s) => ({ ...s, lastQuery: q, lastResults: results }));
    } finally { setSearching(false); }
  };
  const pick = (v: VideoResult) => {
    setSelected(v.id);
    setTimeout(() => setSelected(null), 1200);
    playVideo(v);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const seekClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const target = ((e.clientX - r.left) / r.width) * duration;
    playerRef.current?.seekTo?.(target, true);
    flash(`⤓  ${fmt(target)}`);
  };

  const s = state.settings;
  const pct = duration ? (time / duration) * 100 : 0;

  return (
    <div className="min-h-screen w-full max-w-full overflow-x-hidden bg-background text-foreground">
      <header className="sticky top-0 z-20 border-b border-border bg-background/90 backdrop-blur">
        <div className="mx-auto flex w-full min-w-0 max-w-7xl items-center gap-3 px-3 py-3 sm:gap-4 sm:px-4">
          <div className="flex shrink-0 items-center gap-2 font-bold tracking-tight">
            <img src="/app-icon.png" alt="" className="h-8 w-8 rounded-md object-cover" />
            <span className="hidden sm:flex sm:flex-col sm:leading-tight"><span>Midi YouTube</span><span className="text-muted-foreground font-normal">for Musicians</span></span>
          </div>
          <form onSubmit={doSearch} className="flex min-w-0 flex-1 max-w-2xl">
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search YouTube"
              className="min-w-0 flex-1 rounded-l-full border border-input bg-card px-4 py-2 outline-none focus:border-primary" />
            <Button type="submit" variant="secondary" className="h-auto rounded-l-none rounded-r-full border border-l-0 border-input px-5">
              {searching ? "…" : "Search"}
            </Button>
          </form>
          <Button variant="secondary" size="icon" className="shrink-0" onClick={() => setSettingsOpen(true)}
            aria-label="MIDI Learn and Settings" aria-haspopup="dialog" title="MIDI Learn and Settings">
            <Settings2 />
          </Button>
          <span className={`hidden md:inline text-xs ${midiStatus === "Connected" ? "text-green-500" : "text-muted-foreground"}`}>
            MIDI: {midiStatus}
          </span>
        </div>
      </header>

      <main className="mx-auto w-full min-w-0 max-w-7xl overflow-x-hidden px-3 py-6 sm:px-4">
        <section>
          <div ref={stageRef} className="group relative aspect-video w-full overflow-hidden rounded-xl bg-black [&:fullscreen]:rounded-none [&:fullscreen]:aspect-auto">
            {/* iframe cropped top/bottom to hide title/share and "more videos" bars */}
            <div className="absolute inset-x-0 -top-[60px] -bottom-[60px]">
              <div ref={hostRef} className="h-full w-full" />
            </div>
            {/* click shield: blocks YouTube hover overlays */}
            <div className="absolute inset-0 z-10 cursor-pointer" onClick={() => runAction("playPause")} onDoubleClick={toggleFs} />
            {!state.lastVideo && (
              <div className="absolute inset-0 z-10 grid place-items-center text-muted-foreground pointer-events-none">Search and pick a video</div>
            )}
            {overlay && (
              <div key={overlay.key} className="pointer-events-none absolute inset-0 z-20 grid place-items-center">
                <div className="animate-in fade-in zoom-in-95 rounded-2xl bg-background/80 px-8 py-4 text-3xl font-bold shadow-2xl backdrop-blur">
                  {overlay.text}
                </div>
              </div>
            )}
            <div className="absolute inset-x-0 bottom-0 z-20">
              <div className="flex justify-between px-3 pb-1 text-xs font-medium text-foreground/90 drop-shadow">
                <span>{fmt(time)} / {fmt(duration)}</span>
                <span className="flex gap-3">
                  <span>{s.speed}x · {s.volume}%</span>
                  <button onClick={toggleFs} className="hover:text-primary">{isFs ? "Exit full screen" : "Full screen"}</button>
                </span>
              </div>
              <div className="h-1.5 w-full cursor-pointer bg-foreground/25 hover:h-2.5 transition-all" onClick={seekClick}>
                <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
              </div>
            </div>
          </div>
          <h1 className="mt-3 text-lg font-semibold">{state.lastVideo?.title ?? "No video selected"}</h1>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => runAction("back")}>« {s.seekStep}s</Button>
            <Button onClick={() => runAction("playPause")}>{playing ? "Pause" : "Play"}</Button>
            <Button variant="secondary" onClick={() => runAction("forward")}>{s.seekStep}s »</Button>
            <Button onClick={() => runAction("goto")} title={`Go to ${fmt((s.cues.goto?.m ?? 0) * 60 + (s.cues.goto?.s ?? 0))}`}>Go to</Button>
            <Button variant={state.favorites.some((f) => f.id === state.lastVideo?.id) ? "default" : "secondary"} size="icon" onClick={toggleFavorite}
              disabled={!state.lastVideo} aria-label="Add to favorites" title="Add/remove from favorites">
              <Heart className={state.favorites.some((f) => f.id === state.lastVideo?.id) ? "fill-current" : ""} />
            </Button>
          </div>

          <h2 className="mt-8 mb-3 text-sm uppercase tracking-wider text-muted-foreground">
            {state.lastQuery ? `Results for “${state.lastQuery}”` : "Search results"}
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {state.lastResults.map((v) => {
              const active = state.lastVideo?.id === v.id;
              return (
                <button key={v.id} onClick={() => pick(v)}
                  className={`group/card rounded-xl p-2 text-left transition-all duration-200 hover:-translate-y-1 hover:bg-card hover:ring-2 hover:ring-primary/60 ${
                    selected === v.id ? "bg-primary text-primary-foreground ring-2 ring-primary" : active ? "bg-card ring-1 ring-primary/40" : ""}`}>
                  <div className="relative overflow-hidden rounded-lg">
                    <img src={v.thumbnail} alt="" loading="lazy" className="aspect-video w-full object-cover transition-transform group-hover/card:scale-105" />
                    <span className="absolute bottom-1 right-1 rounded bg-background/85 px-1.5 text-xs text-foreground">{v.duration}</span>
                  </div>
                  <div className="mt-2 line-clamp-2 text-sm font-medium">{v.title}</div>
                  <div className={`text-xs ${selected === v.id ? "" : "text-muted-foreground"}`}>{v.channel} · {v.views}</div>
                </button>
              );
            })}
          </div>
        </section>

        <Dialog open={settingsOpen} onOpenChange={(open) => { setSettingsOpen(open); if (!open) setLearning(null); }}>
          <DialogContent aria-describedby={undefined} className="max-h-[85dvh] w-[calc(100%-2rem)] max-w-xl overflow-y-auto rounded-lg">
            <DialogHeader>
              <DialogTitle>MIDI Learn & Settings</DialogTitle>
            </DialogHeader>
          <section>
            <h2 className="font-semibold">MIDI Learn</h2>
            <p className="text-xs text-muted-foreground mt-1">
              {devices.length ? devices.join(", ") : midiStatus}{lastMsg && ` · last: ${lastMsg}`}
            </p>
            <ul className="mt-3 space-y-1.5">
              {ACTIONS.map((a) => (
                <li key={a.id} className="rounded-md bg-background/50 p-2">
                  <div className="flex items-center gap-2">
                    <span className="flex-1 text-sm">{a.label}</span>
                    <code className="text-xs text-muted-foreground">{s.mappings[a.id] ?? "—"}</code>
                    <button onClick={() => setLearning(learning === a.id ? null : a.id)}
                      className={`rounded px-2 py-0.5 text-xs ${learning === a.id ? "bg-primary text-primary-foreground animate-pulse" : "bg-secondary hover:bg-accent"}`}>
                      {learning === a.id ? "Press…" : "Learn"}
                    </button>
                    {s.mappings[a.id] && (
                      <button onClick={() => setSettings((x) => { const m = { ...x.mappings }; delete m[a.id]; return { ...x, mappings: m }; })}
                        className="text-xs text-muted-foreground hover:text-destructive">✕</button>
                    )}
                  </div>
                  {a.id === "goto" && (
                    <div className="mt-1.5 flex items-center gap-1 text-xs text-muted-foreground">
                      <input type="number" min={0} value={s.cues.goto?.m ?? 0}
                        onChange={(e) => setGoto({ m: Math.max(0, +e.target.value), s: s.cues.goto?.s ?? 0 })}
                        className="w-14 rounded border border-input bg-background px-1.5 py-0.5" /> min
                      <input type="number" min={0} max={59} value={s.cues.goto?.s ?? 0}
                        onChange={(e) => setGoto({ m: s.cues.goto?.m ?? 0, s: Math.min(59, Math.max(0, +e.target.value)) })}
                        className="w-14 rounded border border-input bg-background px-1.5 py-0.5" /> sec
                      <button onClick={() => { const t = Math.floor(time); setGoto({ m: Math.floor(t / 60), s: t % 60 }); }}
                        className="rounded bg-secondary px-2 py-0.5 hover:bg-accent">Current</button>                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>
          <section className="border-t border-border pt-4 space-y-3 text-sm">
            <h2 className="font-semibold">Settings</h2>
            <label className="flex items-center justify-between">Forward / back step (sec)
              <input type="number" min={1} max={600} value={s.seekStep}
                onChange={(e) => setSettings((x) => ({ ...x, seekStep: Math.max(1, +e.target.value || 1) }))}
                className="w-20 rounded border border-input bg-background px-2 py-1" />
            </label>
            <label className="flex items-center justify-between gap-4">Auto full screen on external display / DeX
              <input type="checkbox" checked={s.autoFullscreen} onChange={(e) => setSettings((x) => ({ ...x, autoFullscreen: e.target.checked }))} className="accent-primary h-4 w-4" />
            </label>
          </section>          <section className="border-t border-border pt-4">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold">Favorites</h2>
              <Heart className="h-4 w-4 text-muted-foreground" />
            </div>
            {state.favorites.length === 0 ? (
              <p className="mt-2 text-xs text-muted-foreground">No favorites yet. Press the heart next to “Go to” to save the current video and its Go to position.</p>
            ) : (
              <ul className="mt-3 space-y-2">
                {state.favorites.map((f) => {
                  const gotoSeconds = f.goto.m * 60 + f.goto.s;
                  return (
                    <li key={f.id} className="flex items-center gap-2 rounded-md bg-background/50 p-2">
                      <button onClick={() => openFavorite(f)} className="min-w-0 flex-1 text-left hover:text-primary">
                        <span className="block truncate text-sm font-medium">{f.title}</span>
                        <span className="text-xs text-muted-foreground">Go to {fmt(gotoSeconds)}</span>
                      </button>
                      <a href={"https://www.youtube.com/watch?v=" + f.id + "&t=" + gotoSeconds + "s"} target="_blank" rel="noreferrer"
                        className="rounded bg-secondary px-2 py-1 text-xs hover:bg-accent" title="Open YouTube video at Go to position">
                        Link
                      </a>
                      <button onClick={() => setState((x) => ({ ...x, favorites: x.favorites.filter((item) => item.id !== f.id) }))}
                        className="text-xs text-muted-foreground hover:text-destructive" aria-label="Remove favorite">✕</button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          </DialogContent>
        </Dialog>
      </main>
    </div>
  );
}
