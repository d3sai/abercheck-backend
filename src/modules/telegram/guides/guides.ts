import { type BotReply, button } from '../core/bot-reply';

export const GUIDES_DIR = 'guides';

export const GUIDES = [
  { key: 'request', title: '📝 Як створити запит фінансисту', file: 'novyi-zapyt.mp4' },
  { key: 'answer', title: '✅ Фінансист відповів: що далі', file: 'vidpovid-finansysta.mp4' },
  { key: 'cancel', title: '🗑 Як скасувати запит чи замовлення', file: 'skasuvannia.mp4' },
] as const;

export const GuideAction = {
  Send: /^guide:(\w+)$/,
} as const;

export const GUIDES_MENU: BotReply = {
  html: '🎬 Відео-інструкції. Оберіть тему:',
  buttons: GUIDES.map((guide) => [button(guide.title, `guide:${guide.key}`)]),
};
