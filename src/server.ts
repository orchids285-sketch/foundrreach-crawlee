/**
 * FoundrReach Crawlee scraper service.
 *
 * Self-hosted HTTP API that replaces Apify cloud actors. Routes:
 *
 *   POST /scrape/reddit        { subreddits[], keywords[] }
 *   POST /scrape/indiehackers  { keywords[] }
 *   POST /scrape/producthunt   { competitors[] }
 *   POST /scrape/g2            { competitors[] }
 *   POST /scrape/capterra      { competitors[] }
 *   POST /scrape/linkedin-jobs { roles[] }
 *   GET  /health
 *
 * All endpoints respond with the SAME schema as the Apify actors we replaced,
 * so the Python backend's scrapers can switch CRAWLEE_URL on without code
 * changes (it tries Crawlee first, falls back to Apify).
 *
 * Built on Crawlee (https://github.com/apify/crawlee) + Playwright.
 * Free, open-source, runs on a Railway Node service.
 */
import express, { type Request, type Response } from "express";
import { z } from "zod";
import { CheerioCrawler, PlaywrightCrawler, RequestQueue, log as crawleeLog } from "crawlee";

const app = express();
app.use(express.json({ limit: "1mb" }));
const PORT = Number(process.env.PORT ?? 4001);
const API_KEY = process.env.CRAWLEE_API_KEY ?? "";

crawleeLog.setLevel(crawleeLog.LEVELS.WARNING);

function auth(req: Request, res: Response, next: () => void) {
  if (API_KEY && req.header("authorization") !== `Bearer ${API_KEY}`) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

// ─── Helpers ────────────────────────────────────────────────────────

const userAgents = [
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
];
const rotateUA = () => userAgents[Math.floor(Math.random() * userAgents.length)];

// ─── REDDIT ─────────────────────────────────────────────────────────

const RedditReq = z.object({
  subreddits: z.array(z.string()).max(10),
  keywords: z.array(z.string()).max(15).optional(),
  maxItemsPerSub: z.number().int().positive().max(100).optional(),
});

app.post("/scrape/reddit", auth, async (req, res) => {
  const parsed = RedditReq.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.format() });
  const { subreddits, keywords = [], maxItemsPerSub = 25 } = parsed.data;

  const urls = subreddits.map((s) => `https://www.reddit.com/r/${s}/new.json?limit=${maxItemsPerSub}`);
  for (const kw of keywords.slice(0, 5)) {
    urls.push(`https://api.pullpush.io/reddit/search/submission?q=${encodeURIComponent(kw)}&size=25&sort=new`);
  }

  const items: unknown[] = [];
  const queue = await RequestQueue.open(`reddit-${Date.now()}`);
  for (const url of urls) await queue.addRequest({ url });

  const crawler = new CheerioCrawler({
    requestQueue: queue,
    requestHandlerTimeoutSecs: 30,
    maxConcurrency: 4,
    additionalMimeTypes: ["application/json"],
    preNavigationHooks: [
      async (ctx) => {
        ctx.request.headers ||= {};
        ctx.request.headers["user-agent"] = rotateUA();
      },
    ],
    requestHandler: async ({ request, body }) => {
      try {
        const data = JSON.parse(body.toString());
        const isPullpush = request.url.includes("pullpush.io");
        const children = isPullpush ? data.data : data.data?.children?.map((c: { data: unknown }) => c.data);
        for (const p of children ?? []) {
          if (!p?.id || String(p.id).startsWith("t1_")) continue;
          items.push({
            id: p.id,
            title: p.title,
            body: p.selftext ?? "",
            subreddit: p.subreddit,
            author: p.author,
            url: `https://www.reddit.com${p.permalink ?? `/r/${p.subreddit}/comments/${p.id}/`}`,
            upvotes: p.score ?? 0,
            numberOfComments: p.num_comments ?? 0,
            createdAt: p.created_utc ? new Date(p.created_utc * 1000).toISOString() : null,
          });
        }
      } catch (e) {
        // Some endpoints return HTML when blocked; ignore
      }
    },
  });

  await crawler.run();
  await queue.drop();
  res.json({ items, count: items.length });
});

// ─── INDIEHACKERS ───────────────────────────────────────────────────

const IhReq = z.object({
  keywords: z.array(z.string()).max(8),
  maxTotal: z.number().int().positive().max(80).optional(),
});

app.post("/scrape/indiehackers", auth, async (req, res) => {
  const parsed = IhReq.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.format() });
  const { keywords, maxTotal = 40 } = parsed.data;

  const queue = await RequestQueue.open(`ih-${Date.now()}`);
  for (const kw of keywords) {
    await queue.addRequest({
      url: `https://www.indiehackers.com/search?q=${encodeURIComponent(kw)}&type=post`,
      userData: { kw },
    });
  }

  const items: unknown[] = [];
  const crawler = new PlaywrightCrawler({
    requestQueue: queue,
    requestHandlerTimeoutSecs: 60,
    maxConcurrency: 2,
    headless: true,
    browserPoolOptions: {
      preLaunchHooks: [
        async (_pageId, launchContext) => {
          launchContext.launchOptions ||= {};
          launchContext.launchOptions.userAgent = rotateUA();
        },
      ],
    },
    requestHandler: async ({ page }) => {
      // IH uses Apollo client — wait for posts to render
      await page.waitForSelector('[data-test="post-card"], article', { timeout: 15000 }).catch(() => {});
      const posts = await page.$$eval('article, [data-test="post-card"]', (els) =>
        els.slice(0, 20).map((el) => {
          const a = el.querySelector("a[href*='/post/'], a[href*='/products/']") as HTMLAnchorElement | null;
          const title = (el.querySelector("h2, h3, h4")?.textContent || "").trim();
          const body  = (el.querySelector("p, .post-body, .body")?.textContent || "").trim();
          const author = (el.querySelector("[class*='author'], [class*='user'] a")?.textContent || "").trim();
          return {
            id: a?.href || title,
            url: a?.href || "",
            title, body, author,
          };
        })
      );
      for (const p of posts) if (p.id) items.push({ ...p, source: "indiehackers" });
      if (items.length >= maxTotal) await page.close();
    },
  });

  await crawler.run();
  await queue.drop();
  res.json({ items: items.slice(0, maxTotal), count: items.length });
});

// ─── PRODUCT HUNT (competitor comments) ─────────────────────────────

const PhReq = z.object({
  competitors: z.array(z.string()).max(5),
});

app.post("/scrape/producthunt", auth, async (req, res) => {
  const parsed = PhReq.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.format() });
  const { competitors } = parsed.data;

  const queue = await RequestQueue.open(`ph-${Date.now()}`);
  for (const comp of competitors) {
    const slug = comp.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    await queue.addRequest({
      url: `https://www.producthunt.com/products/${slug}`,
      userData: { comp },
    });
  }

  const items: unknown[] = [];
  const crawler = new PlaywrightCrawler({
    requestQueue: queue,
    requestHandlerTimeoutSecs: 60,
    maxConcurrency: 2,
    headless: true,
    requestHandler: async ({ page, request }) => {
      const comp = (request.userData as { comp?: string })?.comp ?? "";
      await page.waitForSelector('[data-test*="comment"], .comment', { timeout: 15000 }).catch(() => {});
      const comments = await page.$$eval('[data-test*="comment"], .comment', (els) =>
        els.slice(0, 30).map((el) => ({
          id: el.id || el.getAttribute("data-id") || crypto.randomUUID(),
          body: (el.querySelector("[class*='body'], p")?.textContent || "").trim(),
          author: (el.querySelector("[class*='user'] a, [class*='author']")?.textContent || "").trim(),
        }))
      );
      for (const c of comments) {
        if (!c.body || c.body.length < 30) continue;
        items.push({ ...c, competitor: comp, source: "producthunt",
                     url: page.url() });
      }
    },
  });

  await crawler.run();
  await queue.drop();
  res.json({ items, count: items.length });
});

// ─── G2 / CAPTERRA (negative reviews) ───────────────────────────────

const ReviewReq = z.object({
  competitors: z.array(z.string()).max(5),
  maxPerCompetitor: z.number().int().positive().max(40).optional(),
});

async function scrapeReviews(
  competitors: string[],
  maxPer: number,
  pattern: (slug: string) => string,
  platform: string
): Promise<unknown[]> {
  const queue = await RequestQueue.open(`rev-${platform}-${Date.now()}`);
  for (const comp of competitors) {
    const slug = comp.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    await queue.addRequest({ url: pattern(slug), userData: { comp } });
  }
  const items: unknown[] = [];
  const crawler = new PlaywrightCrawler({
    requestQueue: queue,
    requestHandlerTimeoutSecs: 60,
    maxConcurrency: 1,
    headless: true,
    requestHandler: async ({ page, request }) => {
      const comp = (request.userData as { comp?: string })?.comp ?? "";
      await page.waitForLoadState("domcontentloaded");
      const reviews = await page.$$eval(
        '[itemtype*="Review"], .review-item, [class*="review-card"]',
        (els) =>
          els.slice(0, 40).map((el) => {
            const text = (el.querySelector('[class*="content"], [class*="text"]')?.textContent || "").trim();
            const titleEl = el.querySelector('[class*="title"], h3') as HTMLElement | null;
            const ratingEl = el.querySelector('[itemprop="ratingValue"], [class*="rating"], [class*="star"]') as HTMLElement | null;
            const rating = ratingEl?.textContent ? parseFloat(ratingEl.textContent) : 5;
            return {
              title: (titleEl?.textContent || "").trim(),
              text,
              rating,
              author: (el.querySelector('[class*="author"], [class*="user-name"]')?.textContent || "").trim(),
            };
          })
      );
      for (const r of reviews) {
        if (!r.text || r.text.length < 50) continue;
        if (r.rating > 3.5) continue;   // only buyer-intent negatives
        items.push({
          ...r, competitor: comp, platform, url: page.url(),
          id: `${platform}-${comp}-${Math.random().toString(36).slice(2)}`,
        });
        if (items.length >= maxPer * competitors.length) return;
      }
    },
  });
  await crawler.run();
  await queue.drop();
  return items;
}

app.post("/scrape/g2", auth, async (req, res) => {
  const parsed = ReviewReq.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.format() });
  const items = await scrapeReviews(
    parsed.data.competitors,
    parsed.data.maxPerCompetitor ?? 15,
    (slug) => `https://www.g2.com/products/${slug}/reviews`,
    "g2",
  );
  res.json({ items, count: items.length });
});

app.post("/scrape/capterra", auth, async (req, res) => {
  const parsed = ReviewReq.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.format() });
  const items = await scrapeReviews(
    parsed.data.competitors,
    parsed.data.maxPerCompetitor ?? 15,
    (slug) => `https://www.capterra.com/p/${slug}/reviews/`,
    "capterra",
  );
  res.json({ items, count: items.length });
});

// ─── LINKEDIN JOBS (no login required for public listings) ─────────

const JobsReq = z.object({
  roles: z.array(z.string()).max(5),
  location: z.string().optional(),
  maxItems: z.number().int().positive().max(50).optional(),
});

app.post("/scrape/linkedin-jobs", auth, async (req, res) => {
  const parsed = JobsReq.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.format() });
  const { roles, location = "Worldwide", maxItems = 25 } = parsed.data;

  const queue = await RequestQueue.open(`jobs-${Date.now()}`);
  for (const role of roles) {
    const u = `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(role)}&location=${encodeURIComponent(location)}`;
    await queue.addRequest({ url: u, userData: { role } });
  }
  const items: unknown[] = [];
  const crawler = new PlaywrightCrawler({
    requestQueue: queue,
    requestHandlerTimeoutSecs: 45,
    maxConcurrency: 1,
    headless: true,
    requestHandler: async ({ page, request }) => {
      const role = (request.userData as { role?: string })?.role ?? "";
      await page.waitForSelector(".job-search-card, .base-card", { timeout: 12_000 }).catch(() => {});
      const jobs = await page.$$eval(".job-search-card, .base-card", (els) =>
        els.slice(0, 30).map((el) => ({
          id: el.getAttribute("data-entity-urn") || (el.querySelector("a")?.getAttribute("href") || ""),
          title: (el.querySelector(".base-search-card__title, h3")?.textContent || "").trim(),
          company: (el.querySelector(".base-search-card__subtitle, h4")?.textContent || "").trim(),
          location: (el.querySelector(".job-search-card__location")?.textContent || "").trim(),
          url: (el.querySelector("a") as HTMLAnchorElement | null)?.href || "",
          postedAt: el.querySelector("time")?.getAttribute("datetime"),
        }))
      );
      for (const j of jobs) if (j.id) items.push({ ...j, role, source: "linkedin_jobs" });
      if (items.length >= maxItems) await page.close();
    },
  });

  await crawler.run();
  await queue.drop();
  res.json({ items: items.slice(0, maxItems), count: items.length });
});

// ─── Health ─────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "foundrreach-crawlee",
    endpoints: ["/scrape/reddit", "/scrape/indiehackers", "/scrape/producthunt",
                "/scrape/g2", "/scrape/capterra", "/scrape/linkedin-jobs"],
  });
});

app.listen(PORT, () => {
  console.log(`crawlee service listening on :${PORT}`);
});
