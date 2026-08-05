export interface ManagerLookupReader {
  findManagerId(userId: string): Promise<string | null | undefined>;
}
