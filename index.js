/**
 * index.js — Discord Invite Reward Bot (com comandos /invites, /list, /log)
 *
 * Variáveis .env:
 * DISCORD_TOKEN=...
 * API_BASE=http://coin.foxsrv.net:26450
 * RECEIVER_CARD=card_code_to_pay_from
 * WORTH=0.00001000
 * DB_PATH=./invite_rewards.db
 * CHECK_INTERVAL_MS=600000  # opcional (ms)
 *
 * Observações:
 * - Usa POST ${API_BASE}/api/transfer/card { cardCode, toId, amount }
 * - Verificador roda a cada CHECK_INTERVAL_MS (default 10 minutos)
 *
 * Requer: Node >=18, discord.js v14, sqlite3, axios, dotenv
 *
 * Referência do arquivo anterior carregado: :contentReference[oaicite:1]{index=1}
 */

require('dotenv').config();
const { Client, GatewayIntentBits, Partials, EmbedBuilder, PermissionsBitField } = require('discord.js');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const axios = require('axios');
const path = require('path');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN || '';
const API_BASE = process.env.API_BASE || 'http://coin.foxsrv.net:26450';
const RECEIVER_CARD = process.env.RECEIVER_CARD || process.env.CARD || process.env.COIN_CARD || '';
const WORTH = process.env.WORTH || '0.00001000';
const DB_PATH = process.env.DB_PATH || './invite_rewards.db';
const CHECK_INTERVAL_MS = process.env.CHECK_INTERVAL_MS ? parseInt(process.env.CHECK_INTERVAL_MS) : 10 * 60 * 1000;

if (!DISCORD_TOKEN) {
  console.error('Faltando DISCORD_TOKEN no .env');
  process.exit(1);
}
if (!RECEIVER_CARD) {
  console.error('Faltando RECEIVER_CARD (o card usado para pagar) no .env');
  process.exit(1);
}
if (!WORTH) {
  console.error('Faltando WORTH no .env');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildInvites,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.GuildMember]
});

// invites cache: Map<guildId, Map<inviteCode, uses>>
const invitesCache = new Map();
// DB handle
let db;

// For display: timestamp of last periodic run (used to compute remaining time to reward)
let lastPeriodicRun = 0;

/** DB init */
async function initDb() {
  db = await open({
    filename: path.resolve(DB_PATH),
    driver: sqlite3.Database
  });

  await db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
  `);

  // invite rewards
  await db.exec(`
    CREATE TABLE IF NOT EXISTS invite_rewards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      invite_code TEXT,
      inviter_id TEXT NOT NULL,
      joined_id TEXT NOT NULL UNIQUE,
      joined_at INTEGER NOT NULL,
      paid INTEGER DEFAULT 0,
      paid_at INTEGER,
      payment_tx TEXT
    );
  `);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_invite_unpaid_guild ON invite_rewards(guild_id, paid);`);

  // guild config (log channel)
  await db.exec(`
    CREATE TABLE IF NOT EXISTS guild_config (
      guild_id TEXT PRIMARY KEY,
      log_channel_id TEXT
    );
  `);
}

/** Guild config helpers */
async function setLogChannel(guildId, channelId) {
  await db.run(`INSERT INTO guild_config (guild_id, log_channel_id) VALUES (?, ?) ON CONFLICT(guild_id) DO UPDATE SET log_channel_id = excluded.log_channel_id`, [guildId, channelId]);
}
async function clearLogChannel(guildId) {
  await db.run(`DELETE FROM guild_config WHERE guild_id = ?`, [guildId]);
}
async function getLogChannel(guildId) {
  const row = await db.get(`SELECT log_channel_id FROM guild_config WHERE guild_id = ?`, [guildId]);
  return row ? row.log_channel_id : null;
}

/** Invite DB helpers */
async function addPendingInviteRecord(guildId, inviteCode, inviterId, joinedId) {
  try {
    const now = Date.now();
    await db.run(
      `INSERT OR IGNORE INTO invite_rewards (guild_id, invite_code, inviter_id, joined_id, joined_at, paid) VALUES (?, ?, ?, ?, ?, 0)`,
      [guildId, inviteCode || null, String(inviterId), String(joinedId), now]
    );
  } catch (e) {
    console.error('[db] addPendingInviteRecord', e && e.message ? e.message : e);
  }
}
async function markPaid(joinedId, txId) {
  try {
    const now = Date.now();
    await db.run(`UPDATE invite_rewards SET paid = 1, paid_at = ?, payment_tx = ? WHERE joined_id = ?`, [now, txId || null, String(joinedId)]);
  } catch (e) {
    console.error('[db] markPaid', e && e.message ? e.message : e);
  }
}
async function removeInviteRecord(joinedId) {
  try {
    await db.run(`DELETE FROM invite_rewards WHERE joined_id = ?`, [String(joinedId)]);
  } catch (e) {
    console.error('[db] removeInviteRecord', e && e.message ? e.message : e);
  }
}
async function getUnpaidInvites(limit = 1000) {
  try {
    return await db.all(`SELECT * FROM invite_rewards WHERE paid = 0 LIMIT ?`, [limit]);
  } catch (e) {
    console.error('[db] getUnpaidInvites', e && e.message ? e.message : e);
    return [];
  }
}
async function getInviterStats(guildId, inviterId) {
  // Return rows grouped by invite_code with counts and paid counts
  const rows = await db.all(
    `SELECT invite_code, COUNT(*) as joined_count, SUM(paid) as paid_count FROM invite_rewards WHERE guild_id = ? AND inviter_id = ? GROUP BY invite_code`,
    [guildId, String(inviterId)]
  );
  return rows || [];
}
async function getMembersByInviter(guildId, inviterId) {
  const rows = await db.all(
    `SELECT joined_id, joined_at, paid, paid_at FROM invite_rewards WHERE guild_id = ? AND inviter_id = ? ORDER BY joined_at DESC`,
    [guildId, String(inviterId)]
  );
  return rows || [];
}
async function getTotalPaidCountByInviter(guildId, inviterId) {
  const row = await db.get(`SELECT COUNT(*) as cnt FROM invite_rewards WHERE guild_id = ? AND inviter_id = ? AND paid = 1`, [guildId, String(inviterId)]);
  return row ? Number(row.cnt) : 0;
}

/** Payment via Coin API */
async function payViaCard(cardCode, toId, amount) {
  const url = `${API_BASE.replace(/\/$/, '')}/api/transfer/card`;
  try {
    const body = { cardCode: String(cardCode), toId: String(toId), amount: Number(amount) };
    const resp = await axios.post(url, body, { timeout: 15000 });
    if (resp && resp.data) {
      if (resp.data.success === true) {
        const txId = resp.data.txId || resp.data.tx_id || null;
        return { success: true, txId };
      }
      return { success: true, data: resp.data };
    }
    return { success: true };
  } catch (err) {
    const msg = (err && err.response && err.response.data) ? JSON.stringify(err.response.data) : (err && err.message ? err.message : String(err));
    throw new Error(`Payment failed: ${msg}`);
  }
}

/** Utilities */
function truncateDecimals(num, digits) {
  const factor = Math.pow(10, digits);
  return Math.trunc(Number(num) * factor) / factor;
}
function msToMMSS(ms) {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}m`;
}

/** Periodic checker */
async function periodicCheck() {
  console.log('[scheduler] running periodic check...');
  lastPeriodicRun = Date.now();
  try {
    const pending = await getUnpaidInvites(2000);
    if (!pending || pending.length === 0) {
      console.log('[scheduler] none pending');
      return;
    }

    for (const row of pending) {
      try {
        const guild = await client.guilds.fetch(row.guild_id).catch(() => null);
        if (!guild) {
          console.log(`[scheduler] guild ${row.guild_id} not accessible -> removing record ${row.joined_id}`);
          await removeInviteRecord(row.joined_id);
          continue;
        }

        const member = await guild.members.fetch(row.joined_id).catch(() => null);
        if (!member) {
          console.log(`[scheduler] member ${row.joined_id} not in guild ${row.guild_id} -> deleting record`);
          await removeInviteRecord(row.joined_id);
          continue;
        }

        // member still in guild -> pay inviter
        console.log(`[scheduler] paying inviter ${row.inviter_id} for join ${row.joined_id}`);
        try {
          const payRes = await payViaCard(RECEIVER_CARD, row.inviter_id, WORTH);
          const txId = payRes && payRes.txId ? payRes.txId : (payRes && payRes.data && (payRes.data.txId || payRes.data.tx_id) ? (payRes.data.txId || payRes.data.tx_id) : null);
          await markPaid(row.joined_id, txId);
          console.log(`[scheduler] paid inviter ${row.inviter_id} tx=${txId || '(no-tx)'} joined=${row.joined_id}`);

          // Send log to configured channel if present
          const logChannelId = await getLogChannel(row.guild_id);
          if (logChannelId) {
            try {
              const channel = await client.channels.fetch(logChannelId).catch(() => null);
              if (channel && channel?.isTextBased && channel.permissionsFor(client.user)?.has(PermissionsBitField.Flags.SendMessages)) {
                const embed = new EmbedBuilder()
                  .setTitle('Invite Reward Pago')
                  .addFields(
                    { name: 'Invitado', value: `<@${row.joined_id}> (${row.joined_id})`, inline: true },
                    { name: 'Convidou', value: `<@${row.inviter_id}> (${row.inviter_id})`, inline: true },
                    { name: 'Valor', value: String(truncateDecimals(Number(WORTH), 8)), inline: true },
                    { name: 'Invite', value: row.invite_code || '(unknown)', inline: true },
                    { name: 'Tx', value: txId || '(sem tx id)', inline: false }
                  )
                  .setTimestamp();
                await channel.send({ embeds: [embed] });
              }
            } catch (e) {
              console.warn('[scheduler] failed to send log message', e && e.message ? e.message : e);
            }
          }
        } catch (payErr) {
          console.error('[scheduler] payment error:', payErr && payErr.message ? payErr.message : payErr);
        }
      } catch (rowErr) {
        console.error('[scheduler] processing row error', rowErr && rowErr.message ? rowErr.message : rowErr);
      }
    }
  } catch (err) {
    console.error('[scheduler] top-level error', err && err.message ? err.message : err);
  }
}


/** Invite cache refresh */
async function refreshGuildInvites(guild) {
  try {
    const fetched = await guild.invites.fetch();
    const map = new Map();
    for (const inv of fetched.values()) map.set(inv.code, inv.uses || 0);
    invitesCache.set(guild.id, map);
    return map;
  } catch (e) {
    invitesCache.set(guild.id, new Map());
    console.warn('[invites] failed to fetch invites for', guild.id, e && e.message ? e.message : e);
    return new Map();
  }
}

/** Events */
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  // init invites cache for each guild
  for (const [guildId, guild] of client.guilds.cache) {
    try { await refreshGuildInvites(guild); } catch (e) { /* ignore */ }
  }

  // register global slash commands
  const commands = [
    {
      name: 'invites',
      description: 'Mostra a lista de invites de um usuário e total de coins arrecadado',
      options: [
        { name: 'user', description: 'Usuário a ser consultado', type: 6, required: false } // USER
      ]
    },
    {
      name: 'list',
      description: 'Lista membros que entraram pelos seus invites',
      options: [
        { name: 'user', description: 'Usuário a ser consultado', type: 6, required: false } // USER
      ]
    },
    {
      name: 'log',
      description: 'Configura canal de log para eventos de invite (admins only)',
      options: [
        { name: 'set', description: 'Canal para setar logs (use /log set #canal)', type: 11, required: false }, // CHANNEL
        { name: 'clear', description: 'Limpar configuração de log (use /log clear true)', type: 5, required: false } // BOOLEAN (we'll use presence)
      ]
    }
  ];

  try {
    // set globally
    await client.application.commands.set(commands);
    console.log('[commands] global commands registered');
  } catch (e) {
    console.warn('[commands] failed to register global commands', e && e.message ? e.message : e);
  }

  // start periodic checker
  setInterval(() => {
    periodicCheck().catch(e => console.error('[scheduler] periodic failed', e && e.stack ? e.stack : e));
  }, CHECK_INTERVAL_MS);
});

/** Invite created / deleted updates cache */
client.on('inviteCreate', async (invite) => {
  try {
    const guild = invite.guild;
    if (!guild) return;
    const map = invitesCache.get(guild.id) || new Map();
    map.set(invite.code, invite.uses || 0);
    invitesCache.set(guild.id, map);
  } catch (e) {}
});
client.on('inviteDelete', async (invite) => {
  try {
    const guild = invite.guild;
    if (!guild) return;
    const map = invitesCache.get(guild.id) || new Map();
    map.delete(invite.code);
    invitesCache.set(guild.id, map);
  } catch (e) {}
});

/** On member join -> determine invite used and record */
client.on('guildMemberAdd', async (member) => {
  try {
    const guild = member.guild;
    const guildId = guild.id;

    const fetched = await guild.invites.fetch();
    const fetchedArr = Array.from(fetched.values());
    const oldMap = invitesCache.get(guildId) || new Map();
    const newMap = new Map();
    for (const inv of fetchedArr) newMap.set(inv.code, inv.uses || 0);

    // find invite with increased uses
    let used = null;
    for (const [code, uses] of newMap.entries()) {
      const oldUses = oldMap.get(code) || 0;
      if (uses > oldUses) {
        const inv = fetchedArr.find(i => i.code === code);
        used = { code, inviterId: inv && inv.inviter ? String(inv.inviter.id) : null };
        break;
      }
    }

    invitesCache.set(guildId, newMap);

    if (!used) {
      console.log(`[join] Could not determine invite for ${member.user.id} in guild ${guildId}`);
      return;
    }

    await addPendingInviteRecord(guildId, used.code, used.inviterId || '(unknown)', member.user.id);
    console.log(`[join] recorded join: joined=${member.user.id} inviter=${used.inviterId} invite=${used.code} guild=${guildId}`);

    // If guild has log channel configured, send a message about pending join
    const logChannelId = await getLogChannel(guildId);
    if (logChannelId) {
      try {
        const channel = await client.channels.fetch(logChannelId).catch(() => null);
        if (channel && channel?.isTextBased && channel.permissionsFor(client.user)?.has(PermissionsBitField.Flags.SendMessages)) {
          const embed = new EmbedBuilder()
            .setTitle('Novo Invite Usado')
            .addFields(
              { name: 'Novo membro', value: `<@${member.user.id}> (${member.user.id})`, inline: true },
              { name: 'Convidou', value: used.inviterId ? `<@${used.inviterId}> (${used.inviterId})` : '(unknown)', inline: true },
              { name: 'Invite', value: used.code || '(unknown)', inline: true },
              { name: 'Reward (estimado)', value: String(truncateDecimals(Number(WORTH), 8)), inline: true }
            )
            .setTimestamp();
          await channel.send({ embeds: [embed] });
        }
      } catch (e) {
        console.warn('[join] failed to send log message', e && e.message ? e.message : e);
      }
    }
  } catch (err) {
    console.error('[guildMemberAdd] error detecting invite:', err && err.message ? err.message : err);
  }
});

/** Interaction handler for slash commands */
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isCommand()) return;

  const { commandName } = interaction;

  if (commandName === 'invites') {
    await handleInvitesCommand(interaction);
  } else if (commandName === 'list') {
    await handleListCommand(interaction);
  } else if (commandName === 'log') {
    await handleLogCommand(interaction);
  }
});

/** Handle /invites */
async function handleInvitesCommand(interaction) {
  const target = interaction.options.getUser('user') || interaction.user;
  const guild = interaction.guild;
  if (!guild) return interaction.reply({ content: 'Comando só pode ser usado dentro de uma guild.', ephemeral: true });

  await interaction.deferReply({ ephemeral: false });

  // gather stats
  const stats = await getInviterStats(guild.id, target.id);
  if (!stats || stats.length === 0) {
    return interaction.editReply({ content: `Nenhum registro de invites para <@${target.id}>.`, ephemeral: false });
  }

  // build embed fields: each invite code -> joined_count
  const fields = [];
  let totalPaidCount = 0;
  let totalJoined = 0;
  for (const row of stats) {
    const code = row.invite_code || '(unknown)';
    const joinedCount = Number(row.joined_count || 0);
    const paidCount = Number(row.paid_count || 0);
    totalPaidCount += paidCount;
    totalJoined += joinedCount;
    fields.push({ name: `Invite: ${code}`, value: `Entraram: ${joinedCount} — Pagos: ${paidCount}`, inline: false });
  }

  // total coins arrecadado = totalPaidCount * WORTH (truncate to 8 decimals)
  const totalCoins = truncateDecimals(Number(totalPaidCount) * Number(WORTH), 8);

  const embed = new EmbedBuilder()
    .setTitle(`Invites de ${target.tag || `<@${target.id}>`}`)
    .addFields(...fields)
    .setFooter({ text: `Total paid entries: ${totalPaidCount} — Total joined: ${totalJoined}` })
    .setTimestamp();

  // send reply with embed and total below
  await interaction.editReply({
    embeds: [embed],
    content: `Total de coins arrecadado: ${String(totalCoins)}`
  });
}

/** Handle /list */
async function handleListCommand(interaction) {
  const target = interaction.options.getUser('user') || interaction.user;
  const guild = interaction.guild;
  if (!guild) return interaction.reply({ content: 'Comando só pode ser usado dentro de uma guild.', ephemeral: true });

  await interaction.deferReply({ ephemeral: false });

  const members = await getMembersByInviter(guild.id, target.id);
  if (!members || members.length === 0) {
    return interaction.editReply({ content: `Nenhum membro encontrado que tenha entrado pelos invites de <@${target.id}>.` });
  }

  // Build a paginated-ish but simple text: up to 25 fields (embed limit)
  const fields = [];
  const now = Date.now();
  for (const m of members.slice(0, 25)) {
    const joinedAt = Number(m.joined_at || 0);
    const paid = Number(m.paid || 0);
    let marker = '';
    if (paid === 1) {
      marker = '✅ Pago';
    } else {
      // remaining time until next periodic run threshold (we assume periodicCheck interval)
      const elapsed = now - joinedAt;
      const remaining = CHECK_INTERVAL_MS - elapsed;
      if (remaining <= 0) marker = '⌛ Aguardando verificação (próxima execução)';
      else marker = `${msToMMSS(remaining)} para o reward`;
    }
    fields.push({ name: `<@${m.joined_id}>`, value: marker, inline: false });
  }

  const embed = new EmbedBuilder()
    .setTitle(`Lista de membros trazidos por ${target.tag || `<@${target.id}>`}`)
    .addFields(...fields)
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

/** Handle /log
 * usage:
 *  - /log set #channel   -> set log channel
 *  - /log clear true     -> clear log channel (we treat presence of clear option)
 */
async function handleLogCommand(interaction) {
  const member = interaction.member;
  if (!member.permissions.has(PermissionsBitField.Flags.ManageGuild) && !member.permissions.has(PermissionsBitField.Flags.Administrator)) {
    return interaction.reply({ content: 'Você precisa ser administrador/ter Manage Guild para usar este comando.', ephemeral: true });
  }

  // For simplicity: interaction.options has 'set' (channel) and 'clear' (boolean) as defined in registration
  const channelOption = interaction.options.getChannel('set');
  const clearOption = interaction.options.getBoolean('clear');

  if (!channelOption && !clearOption) {
    return interaction.reply({ content: 'Use /log set #canal para configurar ou /log clear true para limpar.', ephemeral: true });
  }

  if (channelOption) {
    // must be a text channel
    if (!channelOption.isTextBased()) {
      return interaction.reply({ content: 'Por favor escolha um canal de texto.', ephemeral: true });
    }
    // check bot permissions to send messages there
    const botPerms = channelOption.permissionsFor(interaction.guild.members.me);
    if (!botPerms || !botPerms.has(PermissionsBitField.Flags.SendMessages)) {
      return interaction.reply({ content: 'Não tenho permissão para enviar mensagens nesse canal.', ephemeral: true });
    }
    await setLogChannel(interaction.guild.id, channelOption.id);
    return interaction.reply({ content: `Canal de log configurado para ${channelOption}.`, ephemeral: false });
  }

  if (clearOption) {
    await clearLogChannel(interaction.guild.id);
    return interaction.reply({ content: 'Configuração de log removida.', ephemeral: false });
  }
}

/** Start */
(async () => {
  try {
    await initDb();
    await client.login(DISCORD_TOKEN);
    console.log('Bot started.');
  } catch (e) {
    console.error('Startup error', e && e.stack ? e.stack : e);
    process.exit(1);
  }
})();
