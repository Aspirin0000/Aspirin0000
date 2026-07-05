import { mkdir, readFile, writeFile } from "node:fs/promises";

const login = process.env.GITHUB_LOGIN || "Aspirin0000";
const token = process.env.GITHUB_TOKEN;
const headers = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
};

const languageColors = {
  "C": "#555555",
  "C++": "#F34B7D",
  "CMake": "#DA3434",
  "CSS": "#663399",
  "Go": "#00ADD8",
  "JavaScript": "#F1E05A",
  "Makefile": "#427819",
  "QMake": "#77D9FB",
  "Shell": "#89E051",
  "TypeScript": "#3178C6",
};

const zhouliVideoFallback = {
  plays: process.env.ZHOULI_VIDEO_PLAYS || "380k+",
  users: process.env.ZHOULI_ACTIVE_USERS || "250k+",
  likes: process.env.ZHOULI_LIKES || "50k+",
};

const zhouliVideoConfig = {
  url: process.env.ZHOULI_VIDEO_URL || "https://www.bilibili.com/video/BV12a7N6qE1g/",
  activeUsersSource: (process.env.ZHOULI_ACTIVE_USERS_SOURCE || "view").toLowerCase(),
};

const cloudflareConfig = {
  zoneId: process.env.CLOUDFLARE_ZONE_ID || process.env.CF_ZONE_ID || "",
  apiToken: process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN || "",
  days: Number(process.env.CLOUDFLARE_ANALYTICS_DAYS || "30"),
  analyticsStartDate: process.env.CLOUDFLARE_ANALYTICS_START_DATE || "",
};

function getBvidFromUrl(value) {
  const match = String(value).match(/\bBV[0-9A-Za-z]{10,12}\b/);
  return match ? match[0] : null;
}

function formatShortMetric(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return "0+";
  }

  if (numeric >= 1_000_000) {
    const million = (numeric / 1_000_000).toFixed(1).replace(/\.0$/, "");
    return `${million}m+`;
  }

  if (numeric >= 1_000) {
    return `${Math.floor(numeric / 1000)}k+`;
  }

  return `${Math.floor(numeric)}+`;
}

function normalizeMetricValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractNumber(obj) {
  if (obj == null) {
    return null;
  }

  if (typeof obj === "number") {
    return normalizeMetricValue(obj);
  }

  if (typeof obj === "string") {
    return normalizeMetricValue(obj);
  }

  if (typeof obj === "object") {
    if (obj.all !== undefined) {
      return normalizeMetricValue(obj.all);
    }

    if (obj.unique !== undefined) {
      return normalizeMetricValue(obj.unique);
    }

    if (obj.uniques !== undefined) {
      return normalizeMetricValue(obj.uniques);
    }
  }

  return null;
}

function parseCloudflareStartDate(value, referenceDate) {
  const text = String(value || "").trim();
  if (!text) {
    return null;
  }

  let parsed = null;

  if (/^\d{1,2}[./-]\d{1,2}$/.test(text)) {
    const [month, day] = text.split(/[./-]/).map(Number);
    if (Number.isInteger(month) && Number.isInteger(day) && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const year = referenceDate.getUTCFullYear();
      parsed = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
    }
  } else {
    parsed = new Date(text);
  }

  if (!parsed || Number.isNaN(parsed.getTime())) {
    return null;
  }

  const normalized = new Date(parsed);
  normalized.setUTCHours(0, 0, 0, 0);
  return normalized;
}

function formatGraphQLDate(date) {
  return date.toISOString().slice(0, 10);
}

function nextUtcDay(date) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

function normalizeCloudflareMetric(payload) {
  const series = payload?.data?.viewer?.zones?.[0]?.httpRequests1dGroups;
  if (!Array.isArray(series)) {
    return null;
  }

  const totals = series
    .map((entry) => {
      const sum = entry?.sum;
      const candidates = [
        extractNumber(sum?.visits),
        extractNumber(sum?.pageViews),
        extractNumber(sum?.requests),
        extractNumber(entry?.uniques),
        extractNumber(entry?.uniq),
      ];
      return candidates.find((value) => value !== null && value >= 0) ?? 0;
    })
    .filter((value) => value > 0);

  if (totals.length === 0) {
    return null;
  }

  const aggregated = totals.reduce((sum, value) => sum + value, 0);
  return aggregated > 0 ? aggregated : null;
}

function normalizeCloudflareVisitsPayload(payload) {
  const series = payload?.data?.viewer?.zones?.[0]?.series;
  if (!Array.isArray(series)) {
    return null;
  }

  const totals = series
    .map((entry) => {
      const sum = entry?.sum;
      if (!sum) {
        return 0;
      }

      const candidates = [
        extractNumber(sum.visits),
        extractNumber(sum.requests),
        extractNumber(sum.edgeResponseBytes),
        extractNumber(entry?.count),
        extractNumber(sum.pageViews),
      ];
      return candidates.find((value) => value !== null && value >= 0) ?? 0;
    })
    .filter((value) => value > 0);

  if (totals.length === 0) {
    return null;
  }

  return totals.reduce((sum, value) => sum + value, 0);
}

async function postCloudflareGraphQL(query) {
  const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cloudflareConfig.apiToken}`,
    },
    body: JSON.stringify({ query }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Cloudflare API returned ${response.status}: ${body}`);
  }

  const payload = await response.json();
  if (payload.errors?.length > 0) {
    throw new Error(payload.errors[0]?.message || "Cloudflare GraphQL returned an error");
  }

  return payload;
}

async function fetchCloudflareUsers() {
  if (!cloudflareConfig.zoneId || !cloudflareConfig.apiToken) {
    throw new Error("Cloudflare zone id or token is not configured for users metric.");
  }

  const requestedRange = Number.isFinite(cloudflareConfig.days) && cloudflareConfig.days > 0 ? Math.floor(cloudflareConfig.days) : 30;
  const explicitStart = parseCloudflareStartDate(cloudflareConfig.analyticsStartDate, new Date());
  if (cloudflareConfig.analyticsStartDate && !explicitStart) {
    console.warn(`Invalid CLOUDFLARE_ANALYTICS_START_DATE "${cloudflareConfig.analyticsStartDate}". Falling back to CLOUDFLARE_ANALYTICS_DAYS=${requestedRange}.`);
  }

  const retentionFallbackRange = explicitStart ? 1 : Math.min(requestedRange, 7);
  let range = requestedRange;
  const now = new Date();
  const endExclusive = new Date(now);
  endExclusive.setUTCHours(0, 0, 0, 0);
  endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);
  const endDate = formatGraphQLDate(endExclusive);
  const startDate = explicitStart && explicitStart < endExclusive ? explicitStart : null;
  const rangeFromStart = startDate ? Math.max(1, Math.floor((endExclusive.getTime() - startDate.getTime()) / 86400000)) : requestedRange;

  if (startDate) {
    const query = `
      query {
        viewer {
          zones(filter: { zoneTag: "${cloudflareConfig.zoneId}" }) {
            httpRequests1dGroups(
              limit: ${Math.max(2, rangeFromStart)}
              filter: { date_geq: "${formatGraphQLDate(startDate)}", date_lt: "${endDate}" }
            ) {
              sum {
                pageViews
                requests
              }
            }
          }
        }
      }
    `;

    const legacyTotal = await postCloudflareGraphQL(query).then((payload) => normalizeCloudflareMetric(payload));
    if (legacyTotal && legacyTotal > 0) {
      return legacyTotal;
    }

    throw new Error(`Cloudflare query from ${formatGraphQLDate(startDate)} to ${endDate} returned no usable user metric.`);
  }

  while (true) {
    const cursorStart = new Date(endExclusive);
    cursorStart.setUTCDate(cursorStart.getUTCDate() - range);
    const dayPayloads = [];

    while (formatGraphQLDate(cursorStart) < endDate) {
      const dayStart = new Date(cursorStart);
      const dayEnd = nextUtcDay(dayStart);
      dayPayloads.push({ dayStart, dayEnd });
      cursorStart.setUTCDate(cursorStart.getUTCDate() + 1);
    }

    if (dayPayloads.length === 0) {
      throw new Error("Cloudflare metrics range resolved to zero days.");
    }

    const requests = dayPayloads.map((batch) => {
      const query = `
        query {
          viewer {
            zones(filter: { zoneTag: "${cloudflareConfig.zoneId}" }) {
              series: httpRequestsAdaptiveGroups(
                limit: 1000
                filter: {
                  requestSource: "eyeball"
                  datetime_geq: "${formatGraphQLDate(batch.dayStart)}T00:00:00Z"
                  datetime_lt: "${formatGraphQLDate(batch.dayEnd)}T00:00:00Z"
                }
              ) {
                sum {
                  visits
                }
              }
            }
          }
        }
      `;

      return postCloudflareGraphQL(query);
    });

    try {
      const responses = await Promise.all(requests);
      const total = responses.reduce((sum, payload) => {
        const value = normalizeCloudflareVisitsPayload(payload);
        return sum + (value ?? 0);
      }, 0);

      if (total <= 0 && dayPayloads.length > 0) {
        const rangeStart = dayPayloads[0].dayStart;
        const fallbackRangeStart = formatGraphQLDate(rangeStart);
        const fallbackRangeEnd = endDate;
        const query = `
          query {
            viewer {
              zones(filter: { zoneTag: "${cloudflareConfig.zoneId}" }) {
                httpRequests1dGroups(
                  limit: ${dayPayloads.length}
                  filter: { date_geq: "${fallbackRangeStart}", date_lt: "${fallbackRangeEnd}" }
                ) {
                  sum {
                    pageViews
                    requests
                  }
                }
              }
            }
          }
        `;
        const legacy = await postCloudflareGraphQL(query).then((payload) => normalizeCloudflareMetric(payload));
        if (legacy && legacy > 0) {
          return legacy;
        }
      }

      if (total <= 0) {
        throw new Error("Cloudflare response does not contain a numeric users metric");
      }

      return total;
    } catch (error) {
      if (range > retentionFallbackRange && /cannot request data older than/i.test(error.message)) {
        range = retentionFallbackRange;
        console.warn(`Cloudflare query range ${requestedRange}d exceeds available analytics retention. Retrying with ${range}d.`);
        continue;
      }

      throw error;
    }
  }
}

function resolveActiveUsersFromVideo(stat) {
  switch (zhouliVideoConfig.activeUsersSource) {
    case "play":
    case "plays":
    case "view":
    case "views":
      return stat.view;
    case "coin":
    case "coins":
      return stat.coin;
    case "favorite":
    case "favorites":
      return stat.favorite;
    case "danmaku":
      return stat.danmaku;
    case "reply":
      return stat.reply;
    case "like":
    case "likes":
      return stat.like;
    case "share":
    case "shares":
      return stat.share;
    default:
      return stat.view;
  }
}

async function fetchZhouliVideoMetrics() {
  const bvid = getBvidFromUrl(zhouliVideoConfig.url);
  if (!bvid) {
    console.warn(`Unable to parse Bilibili BV id from: ${zhouliVideoConfig.url}`);
    return { ...zhouliVideoFallback };
  }

  try {
    const response = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; Codex-Bot/1.0)",
        Referer: "https://www.bilibili.com/",
      },
    });
    if (!response.ok) {
      throw new Error(`Bilibili API returned ${response.status}`);
    }
    const payload = await response.json();
    if (payload.code !== 0 || !payload.data?.stat) {
      throw new Error(`Bilibili API error: ${payload.message || "unknown"}`);
    }

    const stat = payload.data.stat;
    const source = zhouliVideoConfig.activeUsersSource;

    let users = process.env.ZHOULI_ACTIVE_USERS;
    if (!users) {
      if (source === "cloudflare") {
        try {
          const cloudflareUsers = await fetchCloudflareUsers();
          users = formatShortMetric(cloudflareUsers);
        } catch (error) {
          console.warn(`Failed to fetch Cloudflare metrics for users (${error.message}). Falling back to video metric.`);
        }
        if (!users) {
          users = zhouliVideoFallback.users;
        }
      }

      if (!users && source !== "cloudflare") {
        users = formatShortMetric(resolveActiveUsersFromVideo(stat));
      }
    }

    return {
      plays: formatShortMetric(stat.view),
      users,
      likes: formatShortMetric(stat.like),
    };
  } catch (error) {
    console.warn(`Failed to refresh Zhouli metrics from Bilibili (${error.message}). Using fallback values.`);
    return { ...zhouliVideoFallback };
  }
}

const zhouliProjectMeta = {
  title: "合乎周礼 / Zhouli Translator",
  subtitle: "AI-era Chinese style translator · prompt craft · image export · Cloudflare deploy",
  featuredLine: `**Featured:** \`合乎周礼\` — AI-era Chinese translator with production-minded delivery. Current impact: **{plays} video plays**, **{users} active users**, **{likes} likes**.`,
};

async function github(path) {
  const response = await fetch(`https://api.github.com${path}`, { headers });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${path} returned ${response.status}: ${body}`);
  }
  return response.json();
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function compactNumber(value) {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

async function fetchAllRepos() {
  const repos = [];
  for (let page = 1; ; page += 1) {
    const batch = await github(`/users/${login}/repos?per_page=100&page=${page}&sort=updated&type=owner`);
    repos.push(...batch);
    if (batch.length < 100) break;
  }
  return repos.filter((repo) => !repo.fork && !repo.private);
}

async function collect() {
  const [user, repos] = await Promise.all([
    github(`/users/${login}`),
    fetchAllRepos(),
  ]);

  const languageTotals = new Map();
  for (const repo of repos) {
    const languages = await github(`/repos/${login}/${repo.name}/languages`);
    for (const [language, size] of Object.entries(languages)) {
      languageTotals.set(language, (languageTotals.get(language) || 0) + size);
    }
  }

  const stars = repos.reduce((sum, repo) => sum + repo.stargazers_count, 0);
  const forks = repos.reduce((sum, repo) => sum + repo.forks_count, 0);
  const flagship = repos
    .slice()
    .sort((a, b) => b.stargazers_count - a.stargazers_count || new Date(b.updated_at) - new Date(a.updated_at))[0];

  const languages = [...languageTotals.entries()]
    .map(([name, bytes]) => ({ name, bytes, color: languageColors[name] || "#94A3B8" }))
    .sort((a, b) => b.bytes - a.bytes);

  return {
    generatedAt: new Date().toISOString().slice(0, 10),
    user,
    repos,
    stars,
    forks,
    flagship,
    languages,
  };
}

function githubStatsSvg(data) {
  const flagship = data.flagship
    ? `${data.flagship.name} - ${compactNumber(data.flagship.stargazers_count)} stars - updated ${data.flagship.updated_at.slice(0, 10)}`
    : "No public repositories yet";

  return `<svg width="500" height="178" viewBox="0 0 500 178" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="title desc">
  <title id="title">${escapeXml(login)} GitHub stats</title>
  <desc id="desc">An automatically generated GitHub profile statistics card for ${escapeXml(login)}.</desc>
  <defs>
    <linearGradient id="accent" x1="20" y1="0" x2="480" y2="0" gradientUnits="userSpaceOnUse">
      <stop stop-color="#0969DA"/>
      <stop offset="0.52" stop-color="#8250DF"/>
      <stop offset="1" stop-color="#BF3989"/>
    </linearGradient>
  </defs>
  <rect x="0.5" y="0.5" width="499" height="177" rx="8" fill="#FFFFFF" stroke="#D0D7DE"/>
  <rect x="20" y="20" width="460" height="3" rx="1.5" fill="url(#accent)"/>
  <text x="20" y="50" fill="#24292F" font-family="Inter, Segoe UI, Helvetica, Arial, sans-serif" font-size="18" font-weight="700">GitHub Signal</text>
  <text x="20" y="70" fill="#57606A" font-family="Inter, Segoe UI, Helvetica, Arial, sans-serif" font-size="12">Auto-updated daily from GitHub API - ${escapeXml(data.generatedAt)}</text>
  <g font-family="Inter, Segoe UI, Helvetica, Arial, sans-serif">
    <rect x="20" y="91" width="106" height="48" rx="6" fill="#F6F8FA" stroke="#D8DEE4"/>
    <text x="34" y="112" fill="#57606A" font-size="11">Public repos</text>
    <text x="34" y="132" fill="#24292F" font-size="21" font-weight="700">${compactNumber(data.user.public_repos)}</text>
    <rect x="137" y="91" width="106" height="48" rx="6" fill="#F6F8FA" stroke="#D8DEE4"/>
    <text x="151" y="112" fill="#57606A" font-size="11">Stars</text>
    <text x="151" y="132" fill="#24292F" font-size="21" font-weight="700">${compactNumber(data.stars)}</text>
    <rect x="254" y="91" width="106" height="48" rx="6" fill="#F6F8FA" stroke="#D8DEE4"/>
    <text x="268" y="112" fill="#57606A" font-size="11">Forks</text>
    <text x="268" y="132" fill="#24292F" font-size="21" font-weight="700">${compactNumber(data.forks)}</text>
    <rect x="371" y="91" width="109" height="48" rx="6" fill="#F6F8FA" stroke="#D8DEE4"/>
    <text x="385" y="112" fill="#57606A" font-size="11">Followers</text>
    <text x="385" y="132" fill="#24292F" font-size="21" font-weight="700">${compactNumber(data.user.followers)}</text>
  </g>
  <text x="20" y="158" fill="#57606A" font-family="Inter, Segoe UI, Helvetica, Arial, sans-serif" font-size="12">Flagship: ${escapeXml(flagship)}</text>
</svg>
`;
}

function topLanguagesSvg(data) {
  const total = data.languages.reduce((sum, item) => sum + item.bytes, 0);
  const top = data.languages.slice(0, 5);
  const rows = top.map((item, index) => {
    const y = 86 + index * 20;
    const percentage = total ? item.bytes / total : 0;
    const width = Math.max(4, Math.round(250 * percentage));
    return `    <text x="20" y="${y}" fill="#24292F">${escapeXml(item.name)}</text>
    <rect x="115" y="${y - 9}" width="250" height="9" rx="4.5" fill="#EAEEF2"/>
    <rect x="115" y="${y - 9}" width="${width}" height="9" rx="4.5" fill="${item.color}"/>
    <text x="382" y="${y}" fill="#57606A">${(percentage * 100).toFixed(1)}%</text>`;
  }).join("\n");

  return `<svg width="500" height="178" viewBox="0 0 500 178" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="title desc">
  <title id="title">${escapeXml(login)} top languages</title>
  <desc id="desc">An automatically generated language distribution card for public non-fork repositories owned by ${escapeXml(login)}.</desc>
  <rect x="0.5" y="0.5" width="499" height="177" rx="8" fill="#FFFFFF" stroke="#D0D7DE"/>
  <text x="20" y="33" fill="#24292F" font-family="Inter, Segoe UI, Helvetica, Arial, sans-serif" font-size="18" font-weight="700">Top Languages</text>
  <text x="20" y="53" fill="#57606A" font-family="Inter, Segoe UI, Helvetica, Arial, sans-serif" font-size="12">Public non-fork repos - refreshed ${escapeXml(data.generatedAt)}</text>
  <g font-family="Inter, Segoe UI, Helvetica, Arial, sans-serif" font-size="12">
${rows}
  </g>
</svg>
`;
}

function zhouliSpotlightSvg(zhouliProjectSocial) {
  return `<svg width="1000" height="206" viewBox="0 0 1000 206" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="title desc">
  <title id="title">${escapeXml(zhouliProjectMeta.title)}</title>
  <desc id="desc">${escapeXml(zhouliProjectMeta.subtitle)}</desc>
  <defs>
    <linearGradient id="accent" x1="36" y1="28" x2="964" y2="28" gradientUnits="userSpaceOnUse">
      <stop stop-color="#0969DA"/>
      <stop offset="0.48" stop-color="#8250DF"/>
      <stop offset="1" stop-color="#BF3989"/>
    </linearGradient>
  </defs>
  <rect x="0.5" y="0.5" width="999" height="205" rx="14" fill="#FFFFFF" stroke="#D0D7DE"/>
  <path d="M36 28H964" stroke="url(#accent)" stroke-width="3" stroke-linecap="round"/>
  <text x="36" y="64" fill="#57606A" font-family="Inter, Segoe UI, Helvetica, Arial, sans-serif" font-size="14" font-weight="650">FEATURED WORK</text>
  <text x="36" y="103" fill="#24292F" font-family="Inter, Segoe UI, Helvetica, Arial, sans-serif" font-size="31" font-weight="760">${escapeXml(zhouliProjectMeta.title)}</text>
  <text x="36" y="132" fill="#3F4B5B" font-family="Inter, Segoe UI, Helvetica, Arial, sans-serif" font-size="17">${escapeXml(zhouliProjectMeta.subtitle)}</text>
  <text x="36" y="161" fill="#0969DA" font-family="Inter, Segoe UI, Helvetica, Arial, sans-serif" font-size="17" font-weight="700">${escapeXml(`${zhouliProjectSocial.plays} video plays · ${zhouliProjectSocial.users} active users · ${zhouliProjectSocial.likes} likes`)}</text>
</svg>
`;
}

const data = await collect();
const zhouliProjectSocial = await fetchZhouliVideoMetrics();
await updateReadmeFeaturedLine(zhouliProjectSocial);
await mkdir("assets", { recursive: true });
await writeFile("assets/activity-signal.svg", githubStatsSvg(data));
await writeFile("assets/language-mix.svg", topLanguagesSvg(data));
await writeFile("assets/zhouli-spotlight.svg", zhouliSpotlightSvg(zhouliProjectSocial));
await writeFile("assets/zhouli-spotlight-minimal.svg", zhouliSpotlightSvg(zhouliProjectSocial));
console.log(`Generated profile cards for ${login} at ${data.generatedAt}`);

async function updateReadmeFeaturedLine(zhouliProjectSocial) {
  try {
    const readmePath = "README.md";
    const source = await readFile(readmePath, "utf8");
    const nextLine = zhouliProjectMeta.featuredLine
      .replace("{plays}", zhouliProjectSocial.plays)
      .replace("{users}", zhouliProjectSocial.users)
      .replace("{likes}", zhouliProjectSocial.likes);

    const lines = source.split("\n");
    const nextLines = lines.map((line) => {
      if (line.includes("**Featured:**") && line.includes("Current impact:")) {
        return nextLine;
      }
      return line;
    });

    const nextContent = nextLines.join("\n");
    if (nextContent === source) {
      return;
    }

    await writeFile(readmePath, nextContent);
  } catch (error) {
    console.warn(`Failed to sync README featured line (${error.message}).`);
  }
}
