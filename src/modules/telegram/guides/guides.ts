import { type BotReply, button } from '../core/bot-reply';

export const GUIDES_DIR = 'guides';
export const GUIDE_WIDTH = 1920;
export const GUIDE_HEIGHT = 1080;

export const GUIDES = [
  { key: 'request', title: '📝 Як створити запит фінансисту', file: 'novyi-zapyt.mp4' },
  {
    key: 'answer',
    title: '✅ Як прийняти запит і додати квитанцію',
    file: 'vidpovid-finansysta.mp4',
  },
  { key: 'cancel', title: '🗑 Як скасувати запит чи замовлення', file: 'skasuvannia.mp4' },
] as const;

export const GuideAction = {
  Send: /^guide:(\w+)$/,
} as const;

export const GUIDES_MENU: BotReply = {
  html: '🎬 Відео-інструкції. Оберіть тему:',
  buttons: GUIDES.map((guide) => [button(guide.title, `guide:${guide.key}`)]),
};
