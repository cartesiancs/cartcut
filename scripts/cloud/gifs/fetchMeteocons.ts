/**
 * Put the Meteocons weather icons into the cloud catalogue's GIFs.
 *
 *     npx jiti scripts/cloud/gifs/fetchMeteocons.ts [--content server/content] [--cache <dir>] [--limit n] [--dry-run]
 *
 * The 447 animated icons of the "fill" style (MIT, Bas Milius). They ship as
 * Lottie and as SVG animated with SMIL, which ffmpeg cannot play, so each is
 * rendered frame by frame from Lottie in a hidden Electron window
 * (`lottieFrames.cjs`, lottie-web's canvas renderer) and the frames are made
 * into a GIF with the bundled ffmpeg: 256px, 20 frames a second, one loop.
 *
 * Named from the icon's slug (`partly-cloudy-day-rain`), each word with its
 * Korean beside it where there is one, and `weather` and `날씨` always among
 * the words, so either finds the whole set.
 *
 * Both packages are pinned and downloaded from the npm registry into
 * `--cache`, default the system temp folder; nothing is installed.
 */

import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  bundledFfmpeg,
  download,
  eachLimited,
  encodeGif,
  nameFromWords,
  writeCredits,
} from "./gifNames";

const METEOCONS = "https://registry.npmjs.org/@meteocons/lottie/-/lottie-0.1.0.tgz";
const LOTTIE_WEB = "https://registry.npmjs.org/lottie-web/-/lottie-web-5.13.0.tgz";
const STYLE = "fill";
const SIZE = 256;
const FPS = 20;

/** The Korean for the words the slugs are made of. A word not here goes in as English only. */
const KOREAN: Record<string, string> = {
  advisory: "주의보", afternoon: "오후", alarm: "경보", alert: "경고", avalanche: "눈사태",
  barometer: "기압계", beanie: "비니", beaufort: "보퍼트", bolt: "번개", bolts: "번개",
  calm: "고요", celsius: "섭씨", change: "변화", clear: "맑음", closed: "닫힘", cloud: "구름",
  cloudy: "흐림 구름", code: "코드", cold: "추위", colder: "추워짐", compass: "나침반",
  craft: "선박", crescent: "초승달", danger: "위험", day: "낮", direction: "방향", down: "아래",
  drizzle: "이슬비", dust: "먼지", eclipse: "일식", evening: "저녁", extreme: "극심",
  fahrenheit: "화씨", fair: "맑음", falling: "떨어짐", fir: "전나무", first: "상현", flag: "깃발",
  flower: "꽃", fog: "안개", full: "보름", gale: "강풍", gibbous: "볼록달", glass: "유리",
  glove: "장갑", grass: "잔디", green: "초록", hail: "우박", haze: "연무", high: "높음",
  horizon: "지평선", hot: "더위 폭염", humidity: "습도", hurricane: "허리케인 태풍", index: "지수",
  kelvin: "켈빈", last: "하현", late: "늦은", lightning: "번개", low: "낮음", measure: "측정",
  mercury: "수은", mist: "박무 안개", moderate: "보통", moisture: "수분", moon: "달",
  moonrise: "월출", moonset: "월몰", morning: "아침", mostly: "대체로", new: "그믐", night: "밤",
  offshore: "육풍", onshore: "해풍", orange: "주황", overcast: "흐림", particles: "입자",
  partly: "구름조금", pollen: "꽃가루", pressure: "기압", purple: "보라", quarter: "반달",
  rain: "비", rainbow: "무지개", raindrop: "빗방울", raindrops: "빗방울", red: "빨강",
  rocks: "낙석", severe: "매우", sleet: "진눈깨비", small: "소형", smoke: "연기", snow: "눈", snowflake: "눈송이",
  snowman: "눈사람", soil: "토양", solar: "태양", spinner: "로딩", star: "별", starry: "별",
  stars: "별", storm: "폭풍", sun: "해 태양", sunrise: "일출", sunset: "일몰",
  temperature: "온도 기온", thermometer: "온도계", thunderstorms: "뇌우 천둥 번개", tide: "조수",
  time: "시간", tornado: "토네이도", tree: "나무", umbrella: "우산", up: "위", uv: "자외선",
  waning: "기우는", warmer: "따뜻해짐", warning: "경고", water: "물", wave: "파도",
  waxing: "차오르는", weak: "약한", wind: "바람", windmill: "풍차", windsock: "풍향계",
  yellow: "노랑", n: "북", ne: "북동", e: "동", se: "남동", s: "남", sw: "남서", w: "서", nw: "북서",
};

/** Typos in the slugs, read as meant so a search for the right spelling finds them. */
const SPELLING: Record<string, string> = { verry: "very", everning: "evening" };

/**
 * A word a slug repeats, read the second time as this. The extreme set has
 * `extreme-thunderstorms-rain` and `extreme-thunderstorms-extreme-rain`, and a
 * name keeps each word once, so the two would be one file.
 */
const REPEATED: Record<string, string> = { extreme: "severe" };

type Manifest = { categories: { slug: string; icons: { slug: string; animated: boolean }[] }[] };

function nameFor(slug: string): string {
  const english: string[] = [];
  for (const raw of slug.split("-")) {
    const word = SPELLING[raw] ?? raw;
    english.push(english.includes(word) && REPEATED[word] != null ? REPEATED[word] : word);
  }
  const korean = english.flatMap((word) => (KOREAN[word] ?? "").split(" ").filter(Boolean));
  return nameFromWords([...english, ...korean], ["weather", "날씨"]);
}

function extract(tarball: string, into: string): string {
  if (!fs.existsSync(path.join(into, "package"))) {
    fs.mkdirSync(into, { recursive: true });
    execFileSync("tar", ["-xzf", tarball, "-C", into]);
  }
  return path.join(into, "package");
}

async function main() {
  const argv = process.argv.slice(2);
  let content = path.join("server", "content");
  let cache = path.join(os.tmpdir(), "cartcut-meteocons-cache");
  let limit = Infinity;
  let dryRun = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--content") content = argv[++index];
    else if (arg === "--cache") cache = argv[++index];
    else if (arg === "--limit") limit = Number(argv[++index]);
    else if (arg === "--dry-run") dryRun = true;
    else {
      console.error("unknown argument " + arg);
      process.exit(2);
    }
  }
  const gifs = path.join(content, "gifs");

  await download(METEOCONS, path.join(cache, "meteocons.tgz"));
  await download(LOTTIE_WEB, path.join(cache, "lottie-web.tgz"));
  const icons = extract(path.join(cache, "meteocons.tgz"), path.join(cache, "meteocons"));
  const lottieWeb = path.join(
    extract(path.join(cache, "lottie-web.tgz"), path.join(cache, "lottie-web")),
    "build/player/lottie_canvas.min.js",
  );

  const manifest = JSON.parse(fs.readFileSync(path.join(icons, "manifest.json"), "utf8")) as Manifest;
  const slugs = manifest.categories
    .flatMap((category) => category.icons)
    .filter((icon) => icon.animated)
    .map((icon) => icon.slug)
    .slice(0, limit);
  const jobs = slugs.map((slug) => ({ slug, gif: `${nameFor(slug)}.gif` }));
  if (new Set(jobs.map((job) => job.gif)).size !== jobs.length) {
    throw new Error("two icons came out with the same name");
  }
  if (dryRun) {
    for (const job of jobs) {
      console.log(job.gif);
    }
    return;
  }

  // Every frame of every icon, in one Electron run.
  const frames = path.join(cache, "frames");
  const job = path.join(cache, "job.json");
  fs.writeFileSync(
    job,
    JSON.stringify({
      lottieWeb,
      size: SIZE,
      fps: FPS,
      items: jobs.map(({ slug }) => ({
        json: path.join(icons, STYLE, `${slug}.json`),
        outDir: path.join(frames, slug),
      })),
    }),
  );
  // Under node, the electron package's main export is the path of its binary.
  const electron = require("electron") as unknown as string;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const rendered = spawnSync(electron, [path.join(__dirname, "lottieFrames.cjs"), job], {
    env,
    stdio: "inherit",
  });
  if (rendered.status !== 0) {
    throw new Error(`rendering exited with ${rendered.status}`);
  }

  fs.mkdirSync(gifs, { recursive: true });
  const ffmpeg = bundledFfmpeg();
  const failed: string[] = [];
  await eachLimited(jobs, 6, async ({ slug, gif }) => {
    try {
      encodeGif(
        ffmpeg,
        ["-framerate", String(FPS), "-i", path.join(frames, slug, "%04d.png")],
        path.join(gifs, gif),
      );
    } catch (error) {
      failed.push(`${slug}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  writeCredits(gifs);
  for (const line of failed) {
    console.log("failed " + line);
  }
  console.log(`${jobs.length - failed.length} GIFs written to ${gifs}, ${failed.length} failed.`);
  process.exit(failed.length > 0 ? 1 : 0);
}

void main();
