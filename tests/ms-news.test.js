import { describe, it, expect } from "vitest";
import {
  normalizeHeadline, mergeFeeds, relativeTime, filterFeed, groupByDay, newsLeagueSelection
} from "../js/ms-news.js";
import { makeLeague } from "../js/ms-leagues.js";

function article(id, headline, published, extra) {
  return Object.assign({
    id, headline, published, description: "", image: null, link: null,
    sport: "football", leagueId: "football/nfl", leagueName: "NFL"
  }, extra || {});
}

describe("normalizeHeadline", () => {
  it("ignores case, punctuation and spacing", () => {
    expect(normalizeHeadline("Chiefs WIN!  Super Bowl LIX")).toBe(normalizeHeadline("chiefs win - super bowl lix"));
  });
  it("normalises curly apostrophes", () => {
    expect(normalizeHeadline("Mahomes’ night")).toBe(normalizeHeadline("Mahomes' night"));
  });
});

describe("mergeFeeds", () => {
  it("sorts newest first across feeds", () => {
    const out = mergeFeeds([
      [article(1, "Older", "2025-01-01T00:00Z")],
      [article(2, "Newer", "2025-01-05T00:00Z")]
    ]);
    expect(out.map(a => a.headline)).toEqual(["Newer", "Older"]);
  });

  it("dedupes the same story arriving from two leagues and records both", () => {
    const out = mergeFeeds([
      [article(7, "Playoff picture", "2025-01-05T00:00Z", { leagueId: "football/nfl", leagueName: "NFL" })],
      [article(7, "Playoff picture", "2025-01-05T00:00Z", { leagueId: "football/college-football", leagueName: "NCAAF" })]
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].leagues).toEqual(["football/nfl", "football/college-football"]);
    expect(out[0].leagueNames).toEqual(["NFL", "NCAAF"]);
  });

  it("dedupes on the headline when ids differ across leagues", () => {
    const out = mergeFeeds([
      [article(1, "Trade deadline live updates", "2025-01-05T00:00Z", { leagueId: "a", leagueName: "A" })],
      [article(2, "trade deadline live updates!", "2025-01-05T00:00Z", { leagueId: "b", leagueName: "B" })]
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].leagues).toEqual(["a", "b"]);
  });

  it("prefers a copy that has an image", () => {
    const out = mergeFeeds([
      [article(9, "Same story", "2025-01-05T00:00Z", { image: null })],
      [article(9, "Same story", "2025-01-05T00:00Z", { image: "https://x/i.jpg", leagueId: "other" })]
    ]);
    expect(out[0].image).toBe("https://x/i.jpg");
  });

  it("never lists the same league twice on one story", () => {
    const out = mergeFeeds([
      [article(3, "One", "2025-01-05T00:00Z")],
      [article(3, "One", "2025-01-05T00:00Z")]
    ]);
    expect(out[0].leagues).toEqual(["football/nfl"]);
  });

  it("skips entries with no headline and survives nulls", () => {
    expect(mergeFeeds([[{ id: 1 }], null, [null]])).toEqual([]);
    expect(mergeFeeds(null)).toEqual([]);
  });

  it("puts undated articles last rather than dropping them", () => {
    const out = mergeFeeds([[article(1, "Dated", "2025-01-05T00:00Z"), article(2, "Undated", null)]]);
    expect(out).toHaveLength(2);
    expect(out[1].headline).toBe("Undated");
  });
});

describe("relativeTime", () => {
  const now = Date.parse("2025-01-10T12:00:00Z");
  it("describes recent times in minutes and hours", () => {
    expect(relativeTime("2025-01-10T11:59:30Z", now)).toBe("just now");
    expect(relativeTime("2025-01-10T11:30:00Z", now)).toBe("30m ago");
    expect(relativeTime("2025-01-10T09:00:00Z", now)).toBe("3h ago");
  });
  it("switches to days then to a date", () => {
    expect(relativeTime("2025-01-08T12:00:00Z", now)).toBe("2d ago");
    expect(relativeTime("2024-12-01T12:00:00Z", now)).toMatch(/Dec/);
  });
  it("returns an empty string for an unparseable date", () => {
    expect(relativeTime("nonsense", now)).toBe("");
    expect(relativeTime(null, now)).toBe("");
  });
});

describe("filterFeed", () => {
  const feed = mergeFeeds([[
    article(1, "Chiefs clinch", "2025-01-05T00:00Z", { leagueId: "football/nfl", leagueName: "NFL", sport: "football" }),
    article(2, "Lakers trade", "2025-01-04T00:00Z", { leagueId: "basketball/nba", leagueName: "NBA", sport: "basketball" })
  ]]);

  it("filters by league", () => {
    expect(filterFeed(feed, { leagueId: "basketball/nba" })).toHaveLength(1);
  });
  it("filters by sport", () => {
    expect(filterFeed(feed, { sport: "football" })[0].headline).toBe("Chiefs clinch");
  });
  it("filters by free text across headline and league name", () => {
    expect(filterFeed(feed, { query: "lakers" })).toHaveLength(1);
    expect(filterFeed(feed, { query: "NBA" })).toHaveLength(1);
    expect(filterFeed(feed, { query: "zzz" })).toHaveLength(0);
  });
  it("returns everything with no options", () => {
    expect(filterFeed(feed, {})).toHaveLength(2);
    expect(filterFeed(feed)).toHaveLength(2);
  });
});

describe("groupByDay", () => {
  it("splits into today, yesterday and earlier", () => {
    const now = new Date();
    now.setHours(12, 0, 0, 0);
    const nowMs = now.getTime();
    const feed = mergeFeeds([[
      article(1, "Today", new Date(nowMs - 3600000).toISOString()),
      article(2, "Yesterday", new Date(nowMs - 30 * 3600000).toISOString()),
      article(3, "Old", new Date(nowMs - 10 * 86400000).toISOString())
    ]]);
    const b = groupByDay(feed, nowMs);
    expect(b.today).toHaveLength(1);
    expect(b.yesterday).toHaveLength(1);
    expect(b.earlier).toHaveLength(1);
  });
  it("handles an empty feed", () => {
    const b = groupByDay([], Date.now());
    expect(b.today).toEqual([]);
  });
});

describe("newsLeagueSelection", () => {
  const leagues = [
    makeLeague("football", "nfl", "NFL", "NFL", "us"),
    makeLeague("football", "college-football", "NCAAF", "NCAAF", "us"),
    makeLeague("basketball", "nba", "NBA", "NBA", "us")
  ];

  it("always puts the selected league first", () => {
    const picked = newsLeagueSelection(leagues, { selected: leagues[2], max: 3 });
    expect(picked[0].id).toBe("basketball/nba");
  });
  it("never duplicates the selected league", () => {
    const picked = newsLeagueSelection(leagues, { selected: leagues[0], max: 5 });
    expect(picked.filter(l => l.id === "football/nfl")).toHaveLength(1);
  });
  it("caps the number of requests the feed will make", () => {
    expect(newsLeagueSelection(leagues, { max: 2 })).toHaveLength(2);
  });
  it("can restrict to one sport", () => {
    const picked = newsLeagueSelection(leagues, { sport: "football", max: 5 });
    expect(picked.every(l => l.sport === "football")).toBe(true);
  });
  it("handles an empty catalog", () => {
    expect(newsLeagueSelection([], {})).toEqual([]);
  });
});
