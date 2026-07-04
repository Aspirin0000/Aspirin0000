import { mkdir, writeFile } from "node:fs/promises";

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

  return `<svg width="560" height="220" viewBox="0 0 560 220" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="title desc">
  <title id="title">${escapeXml(login)} GitHub stats</title>
  <desc id="desc">An automatically generated GitHub profile statistics card for ${escapeXml(login)}.</desc>
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="560" y2="220" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#0F172A"/>
      <stop offset="0.55" stop-color="#111827"/>
      <stop offset="1" stop-color="#1E293B"/>
    </linearGradient>
    <linearGradient id="accent" x1="36" y1="37" x2="524" y2="37" gradientUnits="userSpaceOnUse">
      <stop stop-color="#38BDF8"/>
      <stop offset="0.52" stop-color="#A78BFA"/>
      <stop offset="1" stop-color="#F472B6"/>
    </linearGradient>
    <filter id="shadow" x="0" y="0" width="560" height="220" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
      <feDropShadow dx="0" dy="12" stdDeviation="18" flood-color="#020617" flood-opacity="0.3"/>
    </filter>
  </defs>
  <rect x="8" y="8" width="544" height="204" rx="16" fill="url(#bg)" stroke="#334155" filter="url(#shadow)"/>
  <rect x="36" y="36" width="488" height="3" rx="1.5" fill="url(#accent)"/>
  <text x="36" y="71" fill="#F8FAFC" font-family="Inter, Segoe UI, Helvetica, Arial, sans-serif" font-size="22" font-weight="700">GitHub Signal</text>
  <text x="36" y="96" fill="#94A3B8" font-family="Inter, Segoe UI, Helvetica, Arial, sans-serif" font-size="13">Auto-updated daily from GitHub API - ${escapeXml(data.generatedAt)}</text>
  <g font-family="Inter, Segoe UI, Helvetica, Arial, sans-serif">
    <rect x="36" y="122" width="104" height="52" rx="10" fill="#0B1220" stroke="#1F2937"/>
    <text x="52" y="145" fill="#94A3B8" font-size="12">Public repos</text>
    <text x="52" y="165" fill="#F8FAFC" font-size="22" font-weight="700">${compactNumber(data.user.public_repos)}</text>
    <rect x="156" y="122" width="104" height="52" rx="10" fill="#0B1220" stroke="#1F2937"/>
    <text x="172" y="145" fill="#94A3B8" font-size="12">Stars</text>
    <text x="172" y="165" fill="#F8FAFC" font-size="22" font-weight="700">${compactNumber(data.stars)}</text>
    <rect x="276" y="122" width="104" height="52" rx="10" fill="#0B1220" stroke="#1F2937"/>
    <text x="292" y="145" fill="#94A3B8" font-size="12">Forks</text>
    <text x="292" y="165" fill="#F8FAFC" font-size="22" font-weight="700">${compactNumber(data.forks)}</text>
    <rect x="396" y="122" width="128" height="52" rx="10" fill="#0B1220" stroke="#1F2937"/>
    <text x="412" y="145" fill="#94A3B8" font-size="12">Followers</text>
    <text x="412" y="165" fill="#F8FAFC" font-size="22" font-weight="700">${compactNumber(data.user.followers)}</text>
  </g>
  <text x="36" y="195" fill="#CBD5E1" font-family="Inter, Segoe UI, Helvetica, Arial, sans-serif" font-size="13">Flagship: ${escapeXml(flagship)}</text>
</svg>
`;
}

function topLanguagesSvg(data) {
  const total = data.languages.reduce((sum, item) => sum + item.bytes, 0);
  const top = data.languages.slice(0, 5);
  const rows = top.map((item, index) => {
    const y = 105 + index * 23;
    const percentage = total ? item.bytes / total : 0;
    const width = Math.max(4, Math.round(350 * percentage));
    return `    <text x="36" y="${y}" fill="#E2E8F0">${escapeXml(item.name)}</text>
    <rect x="126" y="${y - 10}" width="350" height="10" rx="5" fill="#1F2937"/>
    <rect x="126" y="${y - 10}" width="${width}" height="10" rx="5" fill="${item.color}"/>
    <text x="488" y="${y}" fill="#CBD5E1">${(percentage * 100).toFixed(1)}%</text>`;
  }).join("\n");

  return `<svg width="560" height="220" viewBox="0 0 560 220" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="title desc">
  <title id="title">${escapeXml(login)} top languages</title>
  <desc id="desc">An automatically generated language distribution card for public non-fork repositories owned by ${escapeXml(login)}.</desc>
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="560" y2="220" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#111827"/>
      <stop offset="0.58" stop-color="#0F172A"/>
      <stop offset="1" stop-color="#172554"/>
    </linearGradient>
    <filter id="shadow" x="0" y="0" width="560" height="220" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
      <feDropShadow dx="0" dy="12" stdDeviation="18" flood-color="#020617" flood-opacity="0.3"/>
    </filter>
  </defs>
  <rect x="8" y="8" width="544" height="204" rx="16" fill="url(#bg)" stroke="#334155" filter="url(#shadow)"/>
  <text x="36" y="49" fill="#F8FAFC" font-family="Inter, Segoe UI, Helvetica, Arial, sans-serif" font-size="22" font-weight="700">Top Languages</text>
  <text x="36" y="73" fill="#94A3B8" font-family="Inter, Segoe UI, Helvetica, Arial, sans-serif" font-size="13">Public non-fork repos - refreshed ${escapeXml(data.generatedAt)}</text>
  <g font-family="Inter, Segoe UI, Helvetica, Arial, sans-serif" font-size="12">
${rows}
  </g>
</svg>
`;
}

const data = await collect();
await mkdir("assets", { recursive: true });
await writeFile("assets/github-stats.svg", githubStatsSvg(data));
await writeFile("assets/top-langs.svg", topLanguagesSvg(data));
console.log(`Generated profile cards for ${login} at ${data.generatedAt}`);
