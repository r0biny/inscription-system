// Only material URL fields are rewritten, never participants' saved entries.
export function createLabPaths(basePath) {
  const base = `/${basePath.split("/").filter(Boolean).join("/")}/`.replace(/^\/\/$/, "/");
  const url = (path) => `${base}${path.replace(/^\/+/, "")}`;
  const storageKey = (name) => `paper1_lab:${base}:${name}`;
  function materials(value) {
    if (Array.isArray(value)) return value.map(materials);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (key === "entry") return [key, item];
      if (key.endsWith("Url") && typeof item === "string" && item.startsWith("/study-data/")) return [key, url(item)];
      return [key, materials(item)];
    }));
  }
  return { base, url, storageKey, materials };
}
