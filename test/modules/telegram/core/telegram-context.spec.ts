import type { Context } from 'telegraf';
import {
  edit,
  fullName,
  isPrivate,
  reply,
} from '../../../../src/modules/telegram/core/telegram-context';

type ReplyArgs = [string, { reply_markup?: unknown; reply_parameters?: unknown }];
type EditArgs = [string, { reply_markup?: unknown }];

function ctxWith(overrides: Partial<Context> = {}) {
  const replyFn = jest.fn<Promise<unknown>, ReplyArgs>();
  const editFn = jest.fn<Promise<unknown>, EditArgs>();
  const ctx = { reply: replyFn, editMessageText: editFn, ...overrides } as unknown as Context;
  return { ctx, replyFn, editFn };
}

describe('isPrivate', () => {
  it('should be true only for a private chat', () => {
    expect(isPrivate(ctxWith({ chat: { type: 'private' } } as never).ctx)).toBe(true);
    expect(isPrivate(ctxWith({ chat: { type: 'supergroup' } } as never).ctx)).toBe(false);
    expect(isPrivate(ctxWith().ctx)).toBe(false);
  });
});

describe('fullName', () => {
  it('should join the first and last name', () => {
    const { ctx } = ctxWith({ from: { first_name: 'Христина', last_name: 'Гук' } } as never);

    expect(fullName(ctx)).toBe('Христина Гук');
  });

  it('should use just the first name when there is no last name', () => {
    const { ctx } = ctxWith({ from: { first_name: 'Христина' } } as never);

    expect(fullName(ctx)).toBe('Христина');
  });

  it('should fall back to a placeholder when there is no name at all', () => {
    expect(fullName(ctxWith().ctx)).toBe('Без імені');
  });
});

describe('reply', () => {
  it('should send plain HTML with no keyboard by default', async () => {
    const { ctx, replyFn } = ctxWith();

    await reply(ctx, { html: '<b>Привіт</b>' });

    expect(replyFn).toHaveBeenCalledWith('<b>Привіт</b>', {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: undefined,
      reply_parameters: undefined,
    });
  });

  it('should attach the given inline buttons', async () => {
    const { ctx, replyFn } = ctxWith();
    const buttons = [[{ text: 'OK', callback_data: 'ok' }]];

    await reply(ctx, { html: 'text', buttons });

    const [, options] = replyFn.mock.calls[0]!;
    expect(options.reply_markup).toEqual({ inline_keyboard: buttons });
  });

  it('should attach the persistent menu keyboard when menu is true, even with buttons given', async () => {
    const { ctx, replyFn } = ctxWith();
    const buttons = [[{ text: 'OK', callback_data: 'ok' }]];

    await reply(ctx, { html: 'text', buttons, menu: true });

    const [, options] = replyFn.mock.calls[0]!;
    expect(options.reply_markup).not.toEqual({ inline_keyboard: buttons });
    expect(options.reply_markup).toHaveProperty('keyboard');
  });

  it('should force a reply with the given placeholder, taking priority over buttons and menu', async () => {
    const { ctx, replyFn } = ctxWith();

    await reply(ctx, {
      html: 'text',
      buttons: [[{ text: 'OK', callback_data: 'ok' }]],
      menu: true,
      forceReply: { placeholder: '0000-066717' },
    });

    const [, options] = replyFn.mock.calls[0]!;
    expect(options.reply_markup).toEqual({
      force_reply: true,
      selective: true,
      input_field_placeholder: '0000-066717',
    });
  });

  it('should thread the reply to the given message id', async () => {
    const { ctx, replyFn } = ctxWith();

    await reply(ctx, { html: 'text' }, 42);

    const [, options] = replyFn.mock.calls[0]!;
    expect(options.reply_parameters).toEqual({
      message_id: 42,
      allow_sending_without_reply: true,
    });
  });
});

describe('edit', () => {
  it('should edit the message with the given HTML and buttons', async () => {
    const { ctx, editFn } = ctxWith();
    const buttons = [[{ text: 'OK', callback_data: 'ok' }]];

    await edit(ctx, { html: 'text', buttons });

    expect(editFn).toHaveBeenCalledWith('text', {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: buttons },
    });
  });

  it('should clear the keyboard when there are no buttons', async () => {
    const { ctx, editFn } = ctxWith();

    await edit(ctx, { html: 'text' });

    const [, options] = editFn.mock.calls[0]!;
    expect(options.reply_markup).toBeUndefined();
  });
});
