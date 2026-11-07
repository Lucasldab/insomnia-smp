// Checks a "Mod request" issue against Modrinth and the current pack, then
// posts (or updates) one comment with the result. Run by
// .github/workflows/mod-request-check.yml through actions/github-script.
//
// The pack's modrinth.index.json (from the latest release) supplies the
// Minecraft version, the loader and the mods already included, so nothing
// here needs editing when the pack moves to a new version.

const MARKER = "<!-- mod-request-check -->";
const API = "https://api.modrinth.com/v2";
const UA = "Lucasldab/mc-pack (mod request check)";
const LINK = /https?:\/\/(?:www\.)?modrinth\.com\/(?:mod|plugin|datapack|resourcepack|shader|modpack|project)\/([A-Za-z0-9_.-]+)/;

function readPack(text) {
  if (!text) return null;
  const index = JSON.parse(text);
  const deps = index.dependencies || {};
  const loader = Object.keys(deps).find((k) => k !== "minecraft") || "fabric-loader";
  const ids = new Set();
  for (const f of index.files || []) {
    for (const url of f.downloads || []) {
      const m = url.match(/cdn\.modrinth\.com\/data\/([A-Za-z0-9]+)\//);
      if (m) ids.add(m[1]);
    }
  }
  return { mc: deps.minecraft, loader: loader.replace(/-loader$/, ""), ids };
}

const LOADER_NAMES = { fabric: "Fabric", quilt: "Quilt", forge: "Forge", neoforge: "NeoForge" };
const loaderName = (l) => LOADER_NAMES[l] || l;

function where(clientSide, serverSide) {
  if (serverSide === "unsupported") return "only in each player's game (client-side)";
  if (clientSide === "unsupported") return "only on the server";
  if (clientSide === "required" && serverSide === "required") return "on the server and in each player's game";
  return "on the server, in each player's game, or both";
}

async function getJson(fetchImpl, url) {
  const res = await fetchImpl(url, { headers: { "User-Agent": UA } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Modrinth returned HTTP ${res.status}`);
  return res.json();
}

// Builds the comment text. Exported separately so it can be tested offline.
async function buildReport({ body, packText, fetchImpl }) {
  const footer = "\n\n_That was the automatic check. I still go over every request myself before adding anything. – Lucas_";
  const pack = readPack(packText);
  if (!pack || !pack.mc) {
    return "I couldn't read the current pack, so I can't check this yet." + footer;
  }

  const m = (body || "").match(LINK);
  if (!m) {
    return "I couldn't find a Modrinth link in this request. Edit it and paste the mod's page, " +
      "like `https://modrinth.com/mod/sodium`, and I'll check again." + footer;
  }

  const project = await getJson(fetchImpl, `${API}/project/${encodeURIComponent(m[1])}`);
  if (!project) {
    return `I couldn't find \`${m[1]}\` on Modrinth. Check the link and edit the request.` + footer;
  }
  const name = `**${project.title}**`;

  if (pack.ids.has(project.id)) {
    return `${name} is already in the pack.` + footer;
  }
  if (project.project_type !== "mod") {
    return `${name} is a ${project.project_type}, not a mod. You can add it to your own game ` +
      "without changing the pack." + footer;
  }

  const q = new URLSearchParams({
    loaders: JSON.stringify([pack.loader]),
    game_versions: JSON.stringify([pack.mc]),
  });
  const versions = (await getJson(fetchImpl, `${API}/project/${project.id}/version?${q}`)) || [];
  if (versions.length === 0) {
    return `✗ ${name} has no ${loaderName(pack.loader)} version for Minecraft ${pack.mc} yet, so it can't be ` +
      "added right now. It may get one later." + footer;
  }
  const chosen = versions.find((v) => v.version_type === "release") || versions[0];
  const stability = chosen.version_type === "release" ? "" : ` (only a ${chosen.version_type} so far)`;

  const lines = [
    `✓ ${name} has a ${loaderName(pack.loader)} version for Minecraft ${pack.mc}: ` +
      `${chosen.version_number}, released ${chosen.date_published.slice(0, 10)}${stability}.`,
    `It would run ${where(project.client_side, project.server_side)}.`,
  ];

  const needed = (chosen.dependencies || [])
    .filter((d) => d.dependency_type === "required" && d.project_id && !pack.ids.has(d.project_id))
    .map((d) => d.project_id);
  if (needed.length > 0) {
    const q2 = new URLSearchParams({ ids: JSON.stringify(needed) });
    const deps = (await getJson(fetchImpl, `${API}/projects?${q2}`)) || [];
    const names = deps.map((p) => p.title).join(", ") || needed.join(", ");
    lines.push(`It also needs ${names}, which would be added too.`);
  }
  return lines.join("\n\n") + footer;
}

module.exports = async function run({ github, context, packText, fetchImpl = fetch }) {
  const issue = context.payload.issue;
  const text = MARKER + "\n" + (await buildReport({ body: issue.body, packText, fetchImpl }));
  const { owner, repo } = context.repo;
  const comments = await github.paginate(github.rest.issues.listComments, {
    owner, repo, issue_number: issue.number, per_page: 100,
  });
  const mine = comments.find((c) => c.user && c.user.type === "Bot" && (c.body || "").startsWith(MARKER));
  if (mine) {
    await github.rest.issues.updateComment({ owner, repo, comment_id: mine.id, body: text });
  } else {
    await github.rest.issues.createComment({ owner, repo, issue_number: issue.number, body: text });
  }
};

module.exports.buildReport = buildReport;
module.exports.readPack = readPack;
