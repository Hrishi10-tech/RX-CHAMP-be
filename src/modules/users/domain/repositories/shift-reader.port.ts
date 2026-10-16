export const SHIFT_READER = Symbol('SHIFT_READER');

export interface ShiftView {
  id: string;
  start: string;
  end: string;
  companyId?: string;
}

export interface ShiftReader {
  findById(id: string): Promise<ShiftView | null>;
  /** Whether a (not deleted) company with this id exists. */
  companyExists(id: string): Promise<boolean>;
}
