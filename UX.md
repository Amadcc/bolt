# Bolt Sniper Bot - New UX Documentation

## Overview

Новый single-page интерфейс с inline кнопками. Все взаимодействие происходит в одном сообщении, которое редактируется при переходе между страницами.

## Key Features

✅ **Single-Page Interface**
- Одно сообщение, которое редактируется
- Нет бесконечного потока новых сообщений
- Чистый и современный UI

✅ **Inline Navigation**
- Все переходы через кнопки
- Интуитивно понятная навигация
- Быстрый доступ к функциям

✅ **Seamless Wallet Creation**
- `/start` → Create Wallet → Main Dashboard
- Всё в одном окне с инфо о боте
- Автоматический переход после создания

## Page Structure

### 1. Create Wallet Page
**Показывается:** При первом `/start` если нет кошелька

```
🚀 Bolt Sniper Bot

Fastest way to snipe new Solana tokens with built-in safety.

✨ Features:
• Lightning-fast token sniping
• Honeypot detection (95%+ accuracy)
• Non-custodial wallet
• Jupiter v6 integration
• MEV protection

━━━━━━━━━━━━━━━━

💼 Create Your Wallet

📝 Instructions:
1️⃣ Choose a strong password (min 8 characters)
2️⃣ Send your password in the next message
3️⃣ Your wallet will be created and encrypted

🔐 Security:
• Password encrypts your private key
• Uses Argon2id + AES-256-GCM
• Password is NEVER stored
• Message deleted immediately

⚠️ Important:
Don't forget your password! No recovery option.

Made with ❤️ by @amadevstudio

✍️ Send your password now...
```

**Flow:**
1. Пользователь вводит `/start`
2. Сразу показывается Create Wallet (с инфо о боте)
3. Пользователь отправляет пароль (отдельным сообщением)
4. Пароль автоматически удаляется
5. Сообщение обновляется: "⏳ Creating wallet..."
6. После создания: "✅ Wallet Created! Redirecting..."
7. Автоматический переход на Dashboard через 2 секунды

### 2. Main Dashboard
**Показывается:** После создания кошелька или при `/start` с существующим кошельком

```
🏠 Dashboard

💼 Wallet: abcd...xyz
🔓 Status: Unlocked

⚡️ Quick Actions

[🛒 Buy] [💸 Sell]
[🔄 Swap] [📊 Balance]
[💼 Wallet Info] [⚙️ Settings]
[🔒 Lock Wallet]
```

### 3. Buy Page
**Показывается:** При клике на "🛒 Buy"

**Step 1: Select Token**
```
🛒 Buy Tokens

🪙 Select Token:
Choose a token to buy with SOL

[🐕 BONK] [🐶 WIF]
[💵 USDC] [💲 USDT]
[✏️ Custom Address]

[« Back to Dashboard]
```

**Step 2: Select Amount**
```
🛒 Buy Tokens

Selected: BONK

💰 Choose Amount:
How much SOL do you want to spend?

[0.1 SOL] [0.5 SOL]
[1 SOL] [5 SOL]
[✏️ Custom]

[« Back to Dashboard]
```

**Step 3: Execution**
```
🛒 Confirm Purchase

Token: BONK
Amount: 0.5 SOL

⏳ Processing...

[« Back to Dashboard]
```

### 4. Sell Page
**Показывается:** При клике на "💸 Sell"

Аналогично Buy, но с процентами баланса:
```
[25%] [50%]
[75%] [100%]
[✏️ Custom]
```

### 5. Wallet Info
```
💼 Wallet Information

📍 Address:
`abcd...xyz`

⛓ Chain: Solana
🟢 Active

🔗 View on Explorers:
[Solscan] [Solana Explorer]

[📋 Copy Address]
[« Back to Dashboard]
```

### 6. Settings
```
⚙️ Settings

🎯 Slippage: 1%
❌ Auto-approve trades

[🎯 Change Slippage]
[✅ Enable Auto-approve]

[« Back to Dashboard]
```

## Navigation System

### Callback Data Format
```
action:param1:param2:...
```

**Navigation:**
- `nav:create_wallet` - Create wallet page
- `nav:main` - Main dashboard
- `nav:buy` - Buy page
- `nav:sell` - Sell page
- `nav:wallet_info` - Wallet info
- `nav:settings` - Settings

**Actions:**
- `action:unlock` - Unlock wallet
- `action:lock` - Lock wallet
- `action:refresh_balance` - Refresh balance
- `action:copy:ADDRESS` - Copy address

**Buy Flow:**
- `buy:token:BONK` - Select BONK token
- `buy:token:custom` - Enter custom address
- `buy:amount:BONK:0.5` - Buy BONK with 0.5 SOL
- `buy:amount:BONK:custom` - Enter custom amount

**Sell Flow:**
- `sell:token:BONK` - Select BONK token
- `sell:amount:BONK:50` - Sell 50% of BONK
- `sell:amount:BONK:custom` - Enter custom amount

**Settings:**
- `settings:slippage` - Change slippage
- `settings:auto_approve` - Toggle auto-approve

## State Management

### Session Data
```typescript
interface SessionData {
  walletId?: string;
  encryptedKey?: string;
  settings?: {
    slippage: number;
    autoApprove: boolean;
  };
  ui: {
    currentPage: Page;
    messageId?: number;
    buyData?: {
      selectedToken?: string;
      amount?: string;
    };
    sellData?: {
      selectedToken?: string;
      amount?: string;
    };
  };
  awaitingPasswordForWallet?: boolean;
  awaitingPasswordForUnlock?: boolean;
  awaitingInput?: {
    type: "token" | "amount" | "password";
    page: Page;
  };
}
```

## Text Input Handling

Бот обрабатывает текстовые сообщения в следующих случаях:

1. **Создание кошелька** (`awaitingPasswordForWallet`)
   - Сообщение удаляется
   - Пароль обрабатывается
   - Переход на Dashboard

2. **Разблокировка** (`awaitingPasswordForUnlock`)
   - Сообщение удаляется
   - Пароль проверяется
   - Переход на Dashboard

3. **Кастомный ввод** (`awaitingInput`)
   - Адрес токена
   - Сумма
   - Сообщение удаляется
   - Продолжение flow

## Legacy Commands Support

Старые текстовые команды всё ещё работают:

- `/buy BONK 0.1` - Покупка с параметрами
- `/sell BONK 1000000` - Продажа с параметрами
- `/swap USDC BONK 10` - Обмен с параметрами

Если команда вызвана без параметров, показывается UI:
- `/buy` - Открывает Buy page
- `/sell` - Открывает Sell page
- `/swap` - Открывает Swap page

## Implementation Files

```
src/bot/
├── views/
│   └── index.ts              # Page renderers and navigation
├── handlers/
│   └── callbacks.ts          # Callback query handlers
├── commands/
│   ├── createWallet.ts       # Updated for UI
│   ├── session.ts            # Updated with lockSession()
│   ├── buy.ts                # Legacy support
│   ├── sell.ts               # Legacy support
│   └── swap.ts               # Legacy support
└── index.ts                  # Main bot with callback handlers
```

## Testing Checklist

- [ ] Welcome page shows correctly
- [ ] Create wallet flow works end-to-end
- [ ] Dashboard shows after wallet creation
- [ ] Buy flow: token selection → amount → execution
- [ ] Sell flow: token selection → amount → execution
- [ ] Wallet info displays correctly
- [ ] Settings toggle works
- [ ] Lock/Unlock buttons work
- [ ] Navigation back buttons work
- [ ] Custom input (token address, amount) works
- [ ] Password messages are deleted
- [ ] Legacy commands still work

## Security Features

✅ **Password Protection**
- Passwords deleted immediately after input
- Never stored in logs or database

✅ **Session Management**
- Clear unlock/lock states
- Visual indicators (🔓/🔒)

✅ **Input Validation**
- All inputs validated before processing
- Error messages shown in same UI

## Future Improvements

- [ ] Add token balance display on buy/sell pages
- [ ] Add price preview before execution
- [ ] Add transaction history page
- [ ] Add export private key flow
- [ ] Add multi-wallet support
- [ ] Add favorites for tokens
- [ ] Add quick buy presets

---

Made with ❤️ by @amadevstudio
