"use strict";

require('dotenv').config();
const { default: makeWASocket, useSingleFileAuthState, DisconnectReason, fetchLatestBaileysVersion, delay } = require("baileys");
const { Boom } = require("@hapi/boom");
const { google } = require("googleapis");
const fs = require("fs");
const path = require("path");

const { state, saveState } = useSingleFileAuthState('./auth_info.json');

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || "Sheet1";

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
const TOKEN_PATH = 'token.json';
const CREDENTIALS_PATH = 'credentials.json';

let authClient;
let sheets;

async function authorizeGoogle() {
    const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
    const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
    authClient = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

    if (fs.existsSync(TOKEN_PATH)) {
        const token = JSON.parse(fs.readFileSync(TOKEN_PATH));
        authClient.setCredentials(token);
    } else {
        console.error("Google API token not found. Please generate token.json");
        process.exit(1);
    }
    sheets = google.sheets({ version: 'v4', auth: authClient });
}

async function appendChatLog(timestamp, from, message, senderType) {
    if (!sheets) return;
    const values = [[timestamp, from, message, senderType]];
    const resource = { values };
    try {
        await sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: `${SHEET_NAME}!A:D`,
            valueInputOption: 'RAW',
            resource,
        });
    } catch (error) {
        console.error("Error appending chat log:", error);
    }
}

// Conversation states per user
const conversations = new Map();

function formatMenu(title, items) {
    let message = `${title}:\n`;
    items.forEach((item, index) => {
        message += `${index + 1}. ${item}\n`;
    });
    return message.trim();
}

const MENUS = {
    main: ['Info', 'Chat dengan CS', 'Akhiri percakapan', 'Dummy Menu', 'Produk'],
    info: ['PDRB', 'Kembali ke menu sebelumnya'],
    pdrb: ['Nilai PDRB sebesar 1 juta.', 'Kembali ke menu sebelumnya'],
    dummyMenu: ['Dummy Submenu 1', 'Kembali ke menu sebelumnya'],
    dummySubmenu1: ['Kembali ke menu sebelumnya'],
    produk: ['Produk 1', 'Produk 2', 'Produk 3', 'Kembali ke menu sebelumnya'],
    produk1: ['Detail Produk 1', 'Kembali ke menu sebelumnya']
};

const INACTIVITY_TIMEOUT = 2 * 60 * 1000; // 2 minutes

function getCurrentTimestamp() {
    return new Date().toISOString();
}

function sendMessage(sock, jid, message, isBot = true) {
    let finalMessage = message;
    if (isBot) {
        finalMessage += "\n\nchat digenerate oleh bot";
    }
    return sock.sendMessage(jid, { text: finalMessage });
}

function resetInactivityTimeout(jid) {
    const conv = conversations.get(jid);
    if (!conv) return;
    if (conv.timeout) clearTimeout(conv.timeout);
    conv.timeout = setTimeout(() => {
        sendMessage(sock, jid, "Percakapan diakhiri karena tidak ada jawaban selama 2 menit.", true);
        conversations.delete(jid);
    }, INACTIVITY_TIMEOUT);
}

async function startBot() {
    await authorizeGoogle();

    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`Using WA version v${version.join('.')}, isLatest: ${isLatest}`);

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: true,
    });

    sock.ev.on('creds.update', saveState);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('connection closed due to ', lastDisconnect.error, ', reconnecting ', shouldReconnect);
            if (shouldReconnect) {
                startBot();
            }
        } else if (connection === 'open') {
            console.log('opened connection');
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        if (!m.messages || m.type !== 'notify') return;
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const jid = msg.key.remoteJid;
        const fromMe = msg.key.fromMe;
        const messageText = msg.message.conversation || (msg.message.extendedTextMessage && msg.message.extendedTextMessage.text) || "";

        // Log all messages
        await appendChatLog(getCurrentTimestamp(), jid, messageText, 'user');

        // Initialize conversation state if not exists
        if (!conversations.has(jid)) {
            conversations.set(jid, {
                state: 'main',
                csActive: false,
                timeout: null,
            });
            // Send greeting and main menu
            await sendMessage(sock, jid, "Halo! Selamat datang.\n" + MENUS.main);
            resetInactivityTimeout(jid);
            return;
        }

        const conv = conversations.get(jid);

        // If cs is active, check if message is from cs or user
        if (conv.csActive) {
            // If message from user, forward to cs (simulate)
            // If message from cs, check for "terima kasih" to end cs session
            if (messageText.toLowerCase() === "terima kasih") {
                conv.csActive = false;
                conv.state = 'main';
                await sendMessage(sock, jid, "Percakapan kembali diambil alih oleh bot.");
                resetInactivityTimeout(jid);
                return;
            } else {
                // Forward message to cs or user accordingly
                // For simplicity, just acknowledge
                resetInactivityTimeout(jid);
                return;
            }
        }

        // If cs not active, handle menu navigation
        switch (conv.state) {
            case 'main':
                if (messageText === '1') {
                    conv.state = 'info';
                    await sendMessage(sock, jid, formatMenu('Menu', MENUS.main));
                } else if (messageText === '2') {
                    conv.csActive = true;
                    await sendMessage(sock, jid, "mohon tunggu sebentar.");
                } else if (messageText === '3') {
                    await sendMessage(sock, jid, "Percakapan diakhiri. Terima kasih.");
                    conversations.delete(jid);
                } else if (messageText === '4') {
                    conv.state = 'dummyMenu';
                    await sendMessage(sock, jid, formatMenu('Dummy Menu', MENUS.dummyMenu));
                } else if (messageText === '5') {
                    conv.state = 'produk';
                    await sendMessage(sock, jid, formatMenu('Produk', MENUS.produk));
                } else {
                    await sendMessage(sock, jid, "Pilihan tidak valid. Silakan pilih menu:\n" + formatMenu('Menu', MENUS.main));
                }
                resetInactivityTimeout(jid);
                break;

            case 'info':
                if (messageText === '1') {
                    conv.state = 'pdrb';
                    await sendMessage(sock, jid, formatMenu('Menu PDRB', MENUS.pdrb));
                } else if (messageText === '2') {
                    conv.state = 'main';
                    await sendMessage(sock, jid, formatMenu('Menu', MENUS.main));
                } else {
                    await sendMessage(sock, jid, "Pilihan tidak valid. Silakan pilih menu:\n" + formatMenu('Menu Info', MENUS.info));
                }
                resetInactivityTimeout(jid);
                break;

            case 'pdrb':
                if (messageText === '1') {
                    conv.state = 'info';
                    await sendMessage(sock, jid, formatMenu('Menu Info', MENUS.info));
                } else {
                    await sendMessage(sock, jid, "Pilihan tidak valid. Silakan pilih menu:\n" + formatMenu('Menu PDRB', MENUS.pdrb));
                }
                resetInactivityTimeout(jid);
                break;

            case 'dummyMenu':
                if (messageText === '1') {
                    conv.state = 'dummySubmenu1';
                    await sendMessage(sock, jid, formatMenu('Dummy Submenu 1', MENUS.dummySubmenu1));
                } else if (messageText === '2') {
                    conv.state = 'main';
                    await sendMessage(sock, jid, formatMenu('Menu', MENUS.main));
                } else {
                    await sendMessage(sock, jid, "Pilihan tidak valid. Silakan pilih menu:\n" + formatMenu('Dummy Menu', MENUS.dummyMenu));
                }
                resetInactivityTimeout(jid);
                break;

            case 'dummySubmenu1':
                if (messageText === '1') {
                    conv.state = 'dummyMenu';
                    await sendMessage(sock, jid, formatMenu('Dummy Menu', MENUS.dummyMenu));
                } else {
                    await sendMessage(sock, jid, "Pilihan tidak valid. Silakan pilih menu:\n" + formatMenu('Dummy Submenu 1', MENUS.dummySubmenu1));
                }
                resetInactivityTimeout(jid);
                break;

            case 'produk':
                if (messageText === '1') {
                    conv.state = 'produk1';
                    await sendMessage(sock, jid, formatMenu('Detail Produk 1', MENUS.produk1));
                } else if (messageText === '2') {
                    conv.state = 'produk';
                    await sendMessage(sock, jid, formatMenu('Produk', MENUS.produk));
                } else if (messageText === '3') {
                    conv.state = 'produk';
                    await sendMessage(sock, jid, formatMenu('Produk', MENUS.produk));
                } else if (messageText === '4') {
                    conv.state = 'main';
                    await sendMessage(sock, jid, formatMenu('Menu', MENUS.main));
                } else {
                    await sendMessage(sock, jid, "Pilihan tidak valid. Silakan pilih menu:\n" + formatMenu('Produk', MENUS.produk));
                }
                resetInactivityTimeout(jid);
                break;

            case 'produk1':
                if (messageText === '1') {
                    conv.state = 'produk';
                    await sendMessage(sock, jid, formatMenu('Produk', MENUS.produk));
                } else {
                    await sendMessage(sock, jid, "Pilihan tidak valid. Silakan pilih menu:\n" + formatMenu('Detail Produk 1', MENUS.produk1));
                }
                resetInactivityTimeout(jid);
                break;

            default:
                conv.state = 'main';
                await sendMessage(sock, jid, formatMenu('Menu', MENUS.main));
                resetInactivityTimeout(jid);
                break;
        }
    });
}

startBot().catch(err => console.error(err));
