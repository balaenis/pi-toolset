import { describeUser, formatGreeting, parseScore, type User } from './library.js';

const userName = 'Ada';
const greeting = formatGreeting(userName);
const user: User = {
  name: userName,
  score: parseScore('42'),
};

export const message = `${greeting}. ${describeUser(user)}`;
