export type User = {
  name: string;
  score: number;
};

export function formatGreeting(name: string): string {
  return `Hello, ${name}`;
}

export function parseScore(raw: string): number {
  return Number.parseInt(raw, 10);
}

export function describeUser(user: User): string {
  return `${user.name} has score ${user.score}`;
}
