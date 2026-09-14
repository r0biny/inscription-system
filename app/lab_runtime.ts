import { createLabPaths } from "./lab_paths.mjs";

const paths = createLabPaths(import.meta.env.BASE_URL);
export const labUrl = paths.url;
export const labStorageKey = paths.storageKey;
export const labMaterials = <T,>(value: T): T => paths.materials(value) as T;
