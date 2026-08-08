export const SHIFT_READER = Symbol('SHIFT_READER');

export interface ShiftView {
  id: string;
  start: string;
  end: string;
  companyId?: string;
}

export interface ShiftReader {
  findById(id: string): Promise<ShiftView | null>;
}
