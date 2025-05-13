"use strict";

require('dotenv').config();
const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");
const { default: makeWASocket, useSingleFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require("baileys");

const { state, saveState } = useSingleFileAuthState('./auth_info.json');

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || "Sheet1";

const TOKEN_PATH = 'token.json';
const CREDENTIALS_PATH = 'credentials.json';

const INACTIVITY_TIMEOUT = 2 * 60 * 1000; // 2 minutes

// Global variables for Google Sheets API client
let authClient;
let sheets;

// Authorize Google API client
async function authorizeGoogle() {
    try {
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
    } catch (error) {
        console.error("Failed to authorize Google API client:", error);
        process.exit(1);
    }
}

// Append chat log to Google Spreadsheet
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

// Format menu array into numbered string message
function formatMenu(title, items) {
    let message = `${title}:\n`;
    items.forEach((item, index) => {
        message += `${index + 1}. ${item}\n`;
    });
    return message.trim();
}

// Menu definitions as arrays
const MENUS = {
    main: ['Info', 'Chat dengan CS', 'Akhiri percakapan', 'Dummy Menu', 'Produk'],
    info: ['PDRB', 'Kembali ke menu sebelumnya'],
    pdrb: ['Nilai PDRB sebesar 1 juta.', 'Kembali ke menu sebelumnya'],
    dummyMenu: ['Dummy Submenu 1', 'Kembali ke menu sebelumnya'],
    dummySubmenu1: ['Kembali ke menu sebelumnya'],
    produk: ['Produk 1', 'Produk 2', 'Produk 3', 'Kembali ke menu sebelumnya'],
    produk1: ['Detail Produk 1', 'Kembali ke menu sebelumnya']
};

// Conversation states per user
const conversations = new Map();

// Get current ISO timestamp
function getCurrentTimestamp() {
    return new Date().toISOString();
}

// Send message to user, appending bot signature if isBot is true
async function sendMessage(sock, jid, message, isBot = true) {
    const finalMessage = isBot ? `${message}\n\nchat digenerate oleh bot` : message;
    try {
        await sock.sendMessage(jid, { text: finalMessage });
    } catch (error) {
        console.error("Failed to send message:", error);
    }
}

// Reset inactivity timeout for a conversation
function resetInactivityTimeout(sock, jid) {
    const conv = conversations.get(jid);
    if (!conv) return;
    if (conv.timeout) clearTimeout(conv.timeout);
    conv.timeout = setTimeout(async () => {
        await sendMessage(sock, jid, "Percakapan diakhiri karena tidak ada jawaban selama 2 menit.", true);
        conversations.delete(jid);
    }, INACTIVITY_TIMEOUT);
}

// Handle incoming messages and menu navigation
async function handleMessage(sock, msg) {
    if (!msg.message || msg.key.fromMe) return;

    const jid = msg.key.remoteJid;
    const messageText = msg.message.conversation || (msg.message.extendedTextMessage && msg.message.extendedTextMessage.text) || "";

    // Log user message
    await appendChatLog(getCurrentTimestamp(), jid, messageText, 'user');

    // Initialize conversation if new user
    if (!conversations.has(jid)) {
        conversations.set(jid, {
            state: 'main',
            csActive: false,
            timeout: null,
        });
        await sendMessage(sock, jid, `Halo! Selamat datang.\n${formatMenu('Menu', MENUS.main)}`);
        resetInactivityTimeout(sock, jid);
        return;
    }

    const conv = conversations.get(jid);

    // Handle customer service active state
    if (conv.csActive) {
        if (messageText.toLowerCase() === "terima kasih") {
            conv.csActive = false;
            conv.state = 'main';
            await sendMessage(sock, jid, "Percakapan kembali diambil alih oleh bot.");
            resetInactivityTimeout(sock, jid);
            return;
        } else {
            // Simulate forwarding message to CS or user
            resetInactivityTimeout(sock, jid);
            return;
        }
    }

    // Menu navigation logic
    switch (conv.state) {
        case 'main':
            await handleMainMenu(sock, jid, messageText, conv);
            break;
        case 'info':
            await handleInfoMenu(sock, jid, messageText, conv);
            break;
        case 'pdrb':
            await handlePdrbMenu(sock, jid, messageText, conv);
            break;
        case 'dummyMenu':
            await handleDummyMenu(sock, jid, messageText, conv);
            break;
        case 'dummySubmenu1':
            await handleDummySubmenu1(sock, jid, messageText, conv);
            break;
        case 'produk':
            await handleProdukMenu(sock, jid, messageText, conv);
            break;
        case 'produk1':
            await handleProduk1Menu(sock, jid, messageText, conv);
            break;
        default:
            conv.state = 'main';
            await sendMessage(sock, jid, formatMenu('Menu', MENUS.main));
            resetInactivityTimeout(sock, jid);
            break;
    }
}

// Handlers for each menu state
async function handleMainMenu(sock, jid, messageText, conv) {
    switch (messageText) {
        case '1':
            conv.state = 'info';
            await sendMessage(sock, jid, formatMenu('Menu Info', MENUS.info));
            break;
        case '2':
            conv.csActive = true;
            await sendMessage(sock, jid, "mohon tunggu sebentar.");
            break;
        case '3':
            await sendMessage(sock, jid, "Percakapan diakhiri. Terima kasih.");
            conversations.delete(jid);
            break;
        case '4':
            conv.state = 'dummyMenu';
            await sendMessage(sock, jid, formatMenu('Dummy Menu', MENUS.dummyMenu));
            break;
        case '5':
            conv.state = 'produk';
            await sendMessage(sock, jid, formatMenu('Produk', MENUS.produk));
            break;
        default:
            await sendMessage(sock, jid, "Pilihan tidak valid. Silakan pilih menu:\n" + formatMenu('Menu', MENUS.main));
            break;
    }
    resetInactivityTimeout(sock, jid);
}

async function handleInfoMenu(sock, jid, messageText, conv) {
    switch (messageText) {
        case '1':
            conv.state = 'pdrb';
            await sendMessage(sock, jid, formatMenu('Menu PDRB', MENUS.pdrb));
            break;
        case '2':
            conv.state = 'main';
            await sendMessage(sock, jid, formatMenu('Menu', MENUS.main));
            break;
        default:
            await sendMessage(sock, jid, "Pilihan tidak valid. Silakan pilih menu:\n" + formatMenu('Menu Info', MENUS.info));
            break;
    }
    resetInactivityTimeout(sock, jid);
}

async function handlePdrbMenu(sock, jid, messageText, conv) {
    switch (messageText) {
        case '1':
            conv.state = 'info';
            await sendMessage(sock, jid, formatMenu('Menu Info', MENUS.info));
            break;
        default:
            await sendMessage(sock, jid, "Pilihan tidak valid. Silakan pilih menu:\n" + formatMenu('Menu PDRB', MENUS.pdrb));
            break;
    }
    resetInactivityTimeout(sock, jid);
}

async function handleDummyMenu(sock, jid, messageText, conv) {
    switch (messageText) {
        case '1':
            conv.state = 'dummySubmenu1';
            await sendMessage(sock, jid, formatMenu('Dummy Submenu 1', MENUS.dummySubmenu1));
            break;
        case '2':
            conv.state = 'main';
            await sendMessage(sock, jid, formatMenu('Menu', MENUS.main));
            break;
        default:
            await sendMessage(sock, jid, "Pilihan tidak valid. Silakan pilih menu:\n" + formatMenu('Dummy Menu', MENUS.dummyMenu));
            break;
    }
    resetInactivityTimeout(sock, jid);
}

async function handleDummySubmenu1(sock, jid, messageText, conv) {
    switch (messageText) {
        case '1':
            conv.state = 'dummyMenu';
            await sendMessage(sock, jid, formatMenu('Dummy Menu', MENUS.dummyMenu));
            break;
        default:
            await sendMessage(sock, jid, "Pilihan tidak valid. Silakan pilih menu:\n" + formatMenu('Dummy Submenu 1', MENUS.dummySubmenu1));
            break;
    }
    resetInactivityTimeout(sock, jid);
}

async function handleProdukMenu(sock, jid, messageText, conv) {
    switch (messageText) {
        case '1':
            conv.state = 'produk1';
            await sendMessage(sock, jid, formatMenu('Detail Produk 1', MENUS.produk1));
            break;
        case '2':
        case '3':
            // For simplicity, stay in produk menu for Produk 2 and 3
            await sendMessage(sock, jid, formatMenu('Produk', MENUS.produk));
            break;
        case '4':
            conv.state = 'main';
            await sendMessage(sock, jid, formatMenu('Menu', MENUS.main));
            break;
        default:
            await sendMessage(sock, jid, "Pilihan tidak valid. Silakan pilih menu:\n" + formatMenu('Produk', MENUS.produk));
            break;
    }
    resetInactivityTimeout(sock, jid);
}

async function handleProduk1Menu(sock, jid, messageText, conv) {
    switch (messageText) {
        case '1':
            conv.state = 'produk';
            await sendMessage(sock, jid, formatMenu('Produk', MENUS.produk));
            break;
        default:
            await sendMessage(sock, jid, "Pilihan tidak valid. Silakan pilih menu:\n" + formatMenu('Detail Produk 1', MENUS.produk1));
            break;
    }
    resetInactivityTimeout(sock, jid);
}

// Start the WhatsApp bot
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
        await handleMessage(sock, msg);
    });
}

startBot().catch(err => console.error(err));
