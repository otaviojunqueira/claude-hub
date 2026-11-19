// O hub não usa os quadros/placas gerados por IA do habblaud: só a arte procedural.
export type WallArtAsset = unknown; export type BrandAsset = unknown;
export interface WorldAssets { wallArt: never[]; signage?: undefined; mark?: undefined }
export async function loadWorldAssets(): Promise<WorldAssets | null> { return null; }
