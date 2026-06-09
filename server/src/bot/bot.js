// Bot Telegram transactionnel (PLAN §8) — grammY, 100 % français, HTML parse mode.
// Sans TELEGRAM_BOT_TOKEN : désactivation propre (le cockpit fonctionne sans).

import { Bot, InlineKeyboard } from 'grammy';
import { config } from '../config.js';
import { brusselsTime, brusselsDateLong, brusselsDayKey, brusselsDayBoundsUtc } from '../lib/time.js';
import { parseBetMessage } from '../lib/betParser.js';
import { placeBet } from '../services/betsService.js';
import { bankrollStats, ensureInit } from '../services/bankrollService.js';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function createBot(db) {
  if (!config.telegramBotToken) {
    console.log('⏸ Bot Telegram désactivé (TELEGRAM_BOT_TOKEN absent)');
    return null;
  }

  const bot = new Bot(config.telegramBotToken);
  const pendingConfirms = new Map(); // token → interprétation du parseur
  let confirmSeq = 0;

  // Garde mono-utilisateur : si TELEGRAM_CHAT_ID est défini, on ne sert que lui.
  bot.use(async (ctx, next) => {
    const chatId = String(ctx.chat?.id ?? '');
    if (config.telegramChatId && chatId !== String(config.telegramChatId)) {
      if (ctx.message?.text === '/start') {
        await ctx.reply(`Ce bot est privé. Ton chat id : ${chatId}`);
      }
      return;
    }
    await next();
  });

  bot.command('start', (ctx) =>
    ctx.reply(
      `⚽ <b>WC26 Cockpit</b> — bot transactionnel.\n`
      + `Ton chat id : <code>${ctx.chat.id}</code>\n\n`
      + `Commandes : /bankroll /paris /matchs /groupes\n`
      + `Pour encoder un pari, écris-le simplement :\n`
      + `« 20 sur la Belgique @1.85 betfirst »`,
      { parse_mode: 'HTML' }
    )
  );

  bot.command('bankroll', (ctx) => {
    ensureInit(db);
    const s = bankrollStats(db);
    const pct = (x) => (x == null ? '—' : `${(x * 100).toFixed(1)} %`);
    return ctx.reply(
      `💰 <b>Bankroll : ${s.balance.toFixed(2)} €</b> (départ ${s.initial.toFixed(2)} €)\n`
      + `Profit : ${s.profit >= 0 ? '+' : ''}${s.profit.toFixed(2)} € | ROI ${pct(s.roi)} | Yield ${pct(s.yield)}\n`
      + `CLV moyen ${pct(s.avg_clv)} | Réussite ${pct(s.hit_rate)}\n`
      + `Paris ouverts : ${s.bets_open} (exposition ${s.open_exposure.toFixed(2)} €)`,
      { parse_mode: 'HTML' }
    );
  });

  bot.command('paris', (ctx) => {
    const bets = db.prepare(`
      SELECT b.*, th.name AS home_name, ta.name AS away_name, m.kickoff_utc,
             m.home_placeholder, m.away_placeholder
      FROM bets b
      LEFT JOIN matches m ON m.id = b.match_id
      LEFT JOIN teams th ON th.id = m.home_team_id
      LEFT JOIN teams ta ON ta.id = m.away_team_id
      WHERE b.status = 'PENDING' ORDER BY m.kickoff_utc
    `).all();
    if (!bets.length) return ctx.reply('🎫 Aucun pari ouvert.');
    const lines = bets.map((b) => {
      const home = b.home_name || b.home_placeholder || '?';
      const away = b.away_name || b.away_placeholder || '?';
      const pick = b.outcome === 'draw' ? 'Nul' : b.outcome === 'home' ? home : away;
      return `• ${esc(home)} – ${esc(away)} ${b.kickoff_utc ? brusselsTime(b.kickoff_utc) : ''} → <b>${esc(pick)}</b> @${b.odds} (${b.stake.toFixed(2)} €)`;
    });
    return ctx.reply(`🎫 <b>Paris ouverts (${bets.length})</b>\n${lines.join('\n')}`, { parse_mode: 'HTML' });
  });

  bot.command('matchs', (ctx) => {
    const arg = (ctx.match || '').trim().toLowerCase();
    const dayKey = arg === 'demain'
      ? brusselsDayKey(new Date(Date.now() + 24 * 3600 * 1000).toISOString())
      : brusselsDayKey();
    const [start, end] = brusselsDayBoundsUtc(dayKey);
    const matches = db.prepare(`
      SELECT m.*, th.name AS home_name, th.flag_emoji AS hf,
             ta.name AS away_name, ta.flag_emoji AS af
      FROM matches m
      LEFT JOIN teams th ON th.id = m.home_team_id
      LEFT JOIN teams ta ON ta.id = m.away_team_id
      WHERE m.kickoff_utc >= ? AND m.kickoff_utc < ?
      ORDER BY m.kickoff_utc
    `).all(start, end);
    if (!matches.length) return ctx.reply(`📅 Pas de match ${arg === 'demain' ? 'demain' : "aujourd'hui"}.`);
    const lines = matches.map((m) => {
      const home = m.home_name || m.home_placeholder;
      const away = m.away_name || m.away_placeholder;
      const score = m.home_score != null ? ` <b>${m.home_score}-${m.away_score}</b>` : '';
      const live = ['IN_PLAY', 'PAUSED'].includes(m.status) ? ' 🔴' : '';
      const betFlag = db.prepare("SELECT 1 FROM bets WHERE match_id = ? AND status = 'PENDING' LIMIT 1").get(m.id) ? ' 🎫' : '';
      const grp = m.group_code ? ` (Gr. ${m.group_code})` : ` (${m.stage})`;
      return `• ${brusselsTime(m.kickoff_utc)} — ${m.hf || ''} ${esc(home)} vs ${esc(away)} ${m.af || ''}${grp}${score}${live}${betFlag}`;
    });
    return ctx.reply(
      `📅 <b>${esc(brusselsDateLong(start))}</b> (${matches.length} matchs)\n${lines.join('\n')}`,
      { parse_mode: 'HTML' }
    );
  });

  bot.command('groupes', (ctx) => {
    const arg = (ctx.match || '').trim().toUpperCase();
    if (arg && /^[A-L]$/.test(arg)) {
      const rows = db.prepare(`
        SELECT s.*, t.name, t.flag_emoji FROM standings s
        JOIN teams t ON t.id = s.team_id WHERE s.group_code = ? ORDER BY s.position
      `).all(arg);
      if (!rows.length) return ctx.reply(`Groupe ${arg} : pas encore de classement.`);
      const lines = rows.map((r) =>
        `${r.position}. ${r.flag_emoji || ''} ${esc(r.name)} — ${r.points} pts (${r.won}-${r.drawn}-${r.lost}, ${r.goals_for - r.goals_against >= 0 ? '+' : ''}${r.goals_for - r.goals_against})`
      );
      return ctx.reply(`🏆 <b>Groupe ${arg}</b>\n${lines.join('\n')}`, { parse_mode: 'HTML' });
    }
    const rows = db.prepare(`
      SELECT s.group_code, s.position, s.points, t.fifa_code FROM standings s
      JOIN teams t ON t.id = s.team_id ORDER BY s.group_code, s.position
    `).all();
    if (!rows.length) return ctx.reply('Pas encore de classements (seed manquant ?).');
    const byGroup = {};
    for (const r of rows) (byGroup[r.group_code] ||= []).push(`${r.fifa_code} ${r.points}`);
    const lines = Object.entries(byGroup).map(([g, teams]) => `<b>${g}</b> : ${teams.join(' · ')}`);
    return ctx.reply(
      `🏆 <b>Groupes</b> (équipe pts)\n${lines.join('\n')}\nDétail : /groupes A`,
      { parse_mode: 'HTML' }
    );
  });

  // ── Encodage en langage naturel ────────────────────────────
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith('/')) return; // commande inconnue

    const teams = db.prepare('SELECT id, name, fifa_code FROM teams').all();
    const matches = db.prepare(`
      SELECT id, home_team_id, away_team_id, kickoff_utc, status FROM matches
      WHERE status IN ('SCHEDULED','TIMED') ORDER BY kickoff_utc
    `).all();
    const parsed = parseBetMessage(text, { teams, matches });

    if (!parsed.ok) {
      return ctx.reply(
        `🤔 ${esc(parsed.reason)}\nExemple : « 20 sur la Belgique @1.85 betfirst »`,
        { parse_mode: 'HTML' }
      );
    }

    const m = db.prepare(`
      SELECT m.*, th.name AS home_name, ta.name AS away_name FROM matches m
      LEFT JOIN teams th ON th.id = m.home_team_id
      LEFT JOIN teams ta ON ta.id = m.away_team_id
      WHERE m.id = ?
    `).get(parsed.matchId);
    const pick = parsed.outcome === 'draw' ? 'Match nul' : parsed.teamName;
    const token = String(++confirmSeq);
    pendingConfirms.set(token, parsed);
    // Nettoyage des confirmations fantômes
    if (pendingConfirms.size > 20) {
      const oldest = pendingConfirms.keys().next().value;
      pendingConfirms.delete(oldest);
    }

    const issues = parsed.issues.length ? `\n⚠️ ${parsed.issues.map(esc).join('\n⚠️ ')}` : '';
    const kb = new InlineKeyboard()
      .text('✅ Confirmer', `bet:ok:${token}`)
      .text('❌ Annuler', `bet:no:${token}`);
    await ctx.reply(
      `🎫 <b>J'ai compris :</b>\n`
      + `${parsed.stake.toFixed(2)} € sur <b>${esc(pick)}</b> @${parsed.odds}\n`
      + `${esc(m.home_name || m.home_placeholder)} vs ${esc(m.away_name || m.away_placeholder)} — ${brusselsDateLong(m.kickoff_utc)} ${brusselsTime(m.kickoff_utc)}\n`
      + (parsed.bookmaker ? `Bookmaker : ${esc(parsed.bookmaker)}\n` : '')
      + issues
      + `\nJe confirme ?\n<i>(✏️ pour corriger : renvoie simplement le message corrigé)</i>`,
      { parse_mode: 'HTML', reply_markup: kb }
    );
  });

  bot.on('callback_query:data', async (ctx) => {
    const [ns, action, token] = ctx.callbackQuery.data.split(':');
    if (ns !== 'bet') return ctx.answerCallbackQuery();
    const parsed = pendingConfirms.get(token);
    pendingConfirms.delete(token);

    if (!parsed) {
      await ctx.answerCallbackQuery({ text: 'Confirmation expirée.' });
      return ctx.editMessageText('⌛ Confirmation expirée — renvoie ton pari.');
    }
    if (action === 'no') {
      await ctx.answerCallbackQuery({ text: 'Annulé.' });
      return ctx.editMessageText('❌ Pari annulé.');
    }
    try {
      const { bet, warnings } = placeBet(db, {
        match_id: parsed.matchId,
        market: 'h2h',
        outcome: parsed.outcome,
        odds: parsed.odds,
        stake: parsed.stake,
        bookmaker: parsed.bookmaker,
        source: 'telegram',
      });
      await ctx.answerCallbackQuery({ text: 'Pari enregistré !' });
      const warn = warnings.length ? `\n${warnings.map(esc).join('\n')}` : '';
      return ctx.editMessageText(
        `✅ <b>Pari #${bet.id} enregistré</b> — ${bet.stake.toFixed(2)} € @${bet.odds}${warn}\n💰 /bankroll pour le solde.`,
        { parse_mode: 'HTML' }
      );
    } catch (e) {
      await ctx.answerCallbackQuery({ text: 'Erreur.' });
      return ctx.editMessageText(`✖ Erreur : ${esc(e.message)}`);
    }
  });

  bot.catch((err) => console.error('Erreur bot Telegram :', err.message));

  /** Push libre vers le chat configuré (briefs, settlements, alertes). */
  async function notify(text) {
    if (!config.telegramChatId) return false;
    await bot.api.sendMessage(config.telegramChatId, text, { parse_mode: 'HTML' });
    return true;
  }

  return { bot, notify };
}
