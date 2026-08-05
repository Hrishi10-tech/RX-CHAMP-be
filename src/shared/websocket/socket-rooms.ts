export function userRoom(userId: string): string {
  return `user:${userId}`;
}

export function managerRoom(managerId: string): string {
  return `manager:${managerId}`;
}
