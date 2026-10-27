import { Keypair, PublicKey, Transaction } from "https://esm.sh/@solana/web3.js@1.98.4?bundle";
const API = "https://fomopad-api-production.up.railway.app";
const $ = (s) => document.querySelector(s);
const main = $("#main");
let wallet = null, provider = null, minted = null, reserving = false, watch = new Set(JSON.parse(localStorage.getItem("fomopad-watch") || "[]"));
let authToken = localStorage.getItem("fomopad-session"), signedWallet = null, walletMode = "connect", signingIn = false;
let tokens = [], view = "all", toastTimer;
const esc = (s) => String(s ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#39;");
const short = (s) => s ? s.slice(0,5) + "…" + s.slice(-5) : "";
const age = (d) => { let v = Math.max(0, Date.now() - new Date(d).getTime()) / 1000; return v < 60 ? Math.floor(v) + "s" : v < 3600 ? Math.floor(v/60) + "m" : v < 86400 ? Math.floor(v/3600) + "h" : Math.floor(v/86400) + "d"; };
function toast(s) { const t = $("#toast"); t.textContent = s; t.classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 6000); }
async function request(path, options) { const r = await fetch(API + path, options); const v = await r.json(); if (!r.ok) throw Error(v.error || "Request failed"); return v; }
function updateWallet() { $("#walletBtn").innerHTML = wallet ? esc(short(wallet)) + " <span>●</span>" : "Connect wallet <span>↗</span>"; }
function updateAuth() { const b = $("#signInBtn"); b.textContent = signedWallet ? "Signed in · " + short(signedWallet) : "Sign in"; b.classList.toggle("signed", !!signedWallet); }
async function restoreAuth() {
  if (!authToken) return;
  try { const data = await request("/api/auth/me", { headers:{authorization:"Bearer " + authToken} }); signedWallet = data.wallet; updateAuth(); if (["#dashboard","#fees","#rewards","#alerts","#account-data"].includes(location.hash)) route(); }
  catch { authToken = null; signedWallet = null; localStorage.removeItem("fomopad-session"); updateAuth(); }
}
async function signIn() {
  if (signingIn) return;
  if (!wallet || !provider) { openWallet("signin"); return; }
  if (typeof provider.signMessage !== "function") { toast("Your wallet must support signing messages to sign in."); return; }
  signingIn = true;
  const button = $("#signInBtn"); button.disabled = true; button.textContent = "Check wallet…";
  try {
    const challenge = await request("/api/auth/challenge", {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({wallet})});
    if (challenge.wallet !== wallet) throw Error("Wallet changed during sign in");
    const signed = await provider.signMessage(new TextEncoder().encode(challenge.message), "utf8");
    const bytes = signed.signature || signed;
    const signature = btoa(Array.from(bytes, b => String.fromCharCode(b)).join(""));
    const result = await request("/api/auth/verify", {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({wallet,nonce:challenge.nonce,signature})});
    if (result.wallet !== wallet) throw Error("Sign in wallet mismatch");
    authToken = result.token; signedWallet = result.wallet; localStorage.setItem("fomopad-session", authToken);
    $("#walletModal").classList.add("hidden"); toast("Signed in as " + short(signedWallet));
    if (["#dashboard","#fees","#rewards","#alerts","#account-data"].includes(location.hash)) route();
  } catch(e) { toast(e.message || "Sign in cancelled"); }
  finally { signingIn = false; button.disabled = false; updateAuth(); }
}
function openWallet(mode = "connect") { walletMode = mode; $("#walletModalTitle").textContent = mode === "signin" ? "Sign in with your wallet." : "Connect to the trenches."; $("#walletModalText").textContent = mode === "signin" ? "Choose a Solana wallet, then approve a message to sign in. No transaction is sent." : "Fomopad never asks for a wallet seed phrase. You sign the launch in your wallet."; document.querySelectorAll("[data-wallet] small").forEach(el => el.textContent = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ? "Open in wallet app" : "Browser extension"); $("#walletModal").classList.remove("hidden"); }
function walletLink(which) { const page = encodeURIComponent(location.origin + location.pathname + location.search + location.hash); const ref = encodeURIComponent(location.origin); return which === "solflare" ? "https://solflare.com/ul/v1/browse/" + page + "?ref=" + ref : "https://phantom.com/ul/browse/" + page + "?ref=" + ref; }
async function connect(which) {
  const candidate = which === "solflare" ? window.solflare : (window.phantom?.solana || window.solana);
  if (!candidate || typeof candidate.connect !== "function") { if (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) { window.location.href = walletLink(which); return; } toast("Install " + (which === "solflare" ? "Solflare" : "Phantom") + " to connect a Solana wallet."); return; }
  try { const res = await candidate.connect(); provider = candidate; wallet = (res.publicKey || candidate.publicKey).toString(); if (minted && signedWallet !== wallet) minted = null; updateWallet(); $("#walletModal").classList.add("hidden"); if (walletMode === "signin") await signIn(); else if (walletMode === "reserve") await reserveMint(); else toast("Wallet connected: " + short(wallet)); if (["#dashboard","#fees","#rewards","#alerts","#account-data"].includes(location.hash)) route(); if (location.hash === "#launch" && $("#submitLaunch")) $("#submitLaunch").textContent = "Sign & launch coin ↗"; }
  catch(e) { toast(e.message || "Wallet connection cancelled"); }
}
$("#walletBtn").onclick = () => wallet ? (location.hash = "#dashboard") : openWallet();
$("#signInBtn").onclick = () => signedWallet ? ($("#accountWallet").textContent = signedWallet, $("#accountModal").classList.remove("hidden")) : signIn();
$("#closeAccount").onclick = () => $("#accountModal").classList.add("hidden");
$("#accountModal").onclick = (e) => { if (e.target.id === "accountModal") $("#accountModal").classList.add("hidden"); };
$("#accountLaunches").onclick = () => $("#accountModal").classList.add("hidden");
$("#signOutBtn").onclick = async () => { const old = authToken; authToken = null; signedWallet = null; localStorage.removeItem("fomopad-session"); updateAuth(); $("#accountModal").classList.add("hidden"); if (["#dashboard","#fees","#rewards","#alerts","#account-data"].includes(location.hash)) route(); toast("Signed out"); if (old) try { await request("/api/auth/logout", {method:"POST",headers:{authorization:"Bearer " + old}}); } catch {} };
$("#closeModal").onclick = () => $("#walletModal").classList.add("hidden");
$("#walletModal").onclick = (e) => { if (e.target.id === "walletModal") $("#walletModal").classList.add("hidden"); };
document.querySelectorAll("[data-wallet]").forEach((b) => b.onclick = () => connect(b.dataset.wallet));
restoreAuth();
function hero() { return '<section class="hero"><div><div class="eyebrow">A new corner of the trenches</div><h1>The fomo side of <em>Solana.</em></h1><p class="lead">Discover verified launches and make a coin with an address that ends in <b style="color:#d1beff">fomo</b>. Every listing starts with a real on-chain receipt.</p><div class="hero-actions"><a class="primary" href="#launch">Launch a coin ↗</a><a class="secondary" href="#about">How it works</a></div><div class="hero-notes"><span>Verified mints</span><span>Wallet signed</span><span>Open trading</span></div></div><div class="hero-visual"><div class="visual-top"><span>FOMOPAD / THE ADDRESS</span><b>01 / 03</b></div><div class="visual-middle"><small>EVERY COIN HAS A SIGNATURE</small><strong>...<span>fomo</span></strong><p>Not a ticker. Not a tag. Four characters in the actual Solana mint address.</p></div><div class="visual-bottom"><span>Chain: Solana mainnet</span><b>● LIVE VALIDATION</b></div></div></section>'; }
const money = (v) => Number.isFinite(Number(v)) && v !== null ? "$" + Number(v).toLocaleString("en-US",{maximumFractionDigits:Number(v)<.01?8:2}) : "—";
function empty(message, cta) { return '<div class="empty"><div class="empty-symbol">f.</div><h3>' + esc(message) + '</h3><p>Verified launches will appear here after their Solana transactions confirm.</p>' + (cta ? '<a class="primary" href="#launch">Launch a coin ↗</a>' : '') + '</div>'; }
function tokenRows(list) { return list.map(t => '<tr><td><a class="token-cell" href="#token/' + esc(t.mint) + '"><img class="token-img" src="' + esc(t.image) + '" alt=""><span><b>' + esc(t.name) + '</b><span class="token-symbol">$' + esc(t.symbol) + '</span></span></a></td><td>' + age(t.launchedAt) + '</td><td><b>' + money(t.market?.priceUsd) + '</b></td><td>' + money(t.market?.volume24hUsd) + '</td><td><a class="address" href="https://solscan.io/token/' + esc(t.mint) + '" target="_blank" rel="noopener">' + esc(short(t.mint)) + ' ↗</a></td><td><span class="tag">Verified</span></td><td><a class="table-action" href="#token/' + esc(t.mint) + '">Explore ↗</a></td></tr>').join(""); }
function table(list, isBoard) { return '<div class="table-wrap"><table><thead><tr><th>TOKEN</th><th>AGE</th><th>PRICE</th><th>24H VOL</th><th>MINT ADDRESS</th><th>STATUS</th><th></th></tr></thead><tbody>' + tokenRows(list) + '</tbody></table></div>' + (list.length ? '' : empty(isBoard ? "No launches yet" : "Nothing here yet", isBoard)); }
function coinCards(list) {
  return list.map(t => {
    const change = Number(t.market?.change24hPct);
    const hasChange = t.market?.change24hPct != null && Number.isFinite(change);
    const duplicate = tokens.some(other => other.mint !== t.mint && other.symbol.toLowerCase() === t.symbol.toLowerCase());
    const progress = t.curve ? (t.curve.migrated ? 'Graduated' : t.curve.progressPercent.toFixed(1) + '% to graduation') : 'Curve reading unavailable';
    const paid = Number(t.rewardPaidLamports || 0);
    const activity = '<div class="coin-activity"><span>' + esc(progress) + '</span>' + (paid > 0 ? '<span>' + (paid / 1e9).toFixed(4) + ' SOL paid to Fomo traders</span>' : '') + '</div>';
    return '<article class="coin-card"><a class="coin-cover" href="#token/' + esc(t.mint) + '" aria-label="Open Fomopad chart for ' + esc(t.name) + '"><img src="' + esc(t.image) + '" alt="' + esc(t.name) + ' coin artwork" loading="lazy"><span class="coin-verified">✓ On-chain verified</span></a><div class="coin-card-body"><div class="coin-name"><div><h2>' + esc(t.symbol) + '</h2><span>' + esc(t.name) + '</span></div><small>' + age(t.launchedAt) + ' ago</small></div><div class="coin-metrics"><div><span>PRICE</span><strong>' + money(t.market?.priceUsd) + '</strong></div><div><span>LIQUIDITY</span><strong>' + money(t.market?.liquidityUsd) + '</strong></div><div><span>VOL 24H</span><strong>' + money(t.market?.volume24hUsd) + '</strong></div></div><div class="coin-meta">' + (hasChange ? '<span class="coin-change ' + (change >= 0 ? 'up' : 'down') + '">' + (change >= 0 ? '+' : '') + change.toFixed(1) + '% in 24h</span>' : '<span>Market data pending</span>') + '<span>·</span><span>' + (t.protocol === 'DBC' ? 'Meteora DBC' : t.protocol === 'STONK' ? 'Stonk.fun' : 'Bonding curve') + '</span></div>' + activity + (duplicate ? '<p class="coin-warning">Ticker shared by another launch. Verify the mint.</p>' : '') + '</div><div class="coin-card-foot"><div><small>FOMOPAD MINT</small><a href="https://solscan.io/token/' + esc(t.mint) + '" target="_blank" rel="noopener" title="View mint on Solscan">' + esc(short(t.mint)) + ' ↗</a></div><div class="coin-card-actions"><a href="#token/' + esc(t.mint) + '">Chart</a><a class="coin-open" href="https://fomo.family/tokens/solana/' + esc(t.mint) + '" target="_blank" rel="noopener noreferrer">View coin ↗</a></div></div></article>';
  }).join('');
}
let boardRequest = 0;
async function loadBoard(q) { const run = ++boardRequest; try { let data; for (let attempt=0; attempt<2; attempt++) { try { data = await request("/api/tokens" + (q ? "?q=" + encodeURIComponent(q) : "")); break; } catch(e) { if (attempt) throw e; await new Promise(resolve=>setTimeout(resolve,900)); } } if (run !== boardRequest || !$("#boardContent")) return; tokens = data.tokens; document.querySelector(".board-stale")?.remove(); if (!q) try { sessionStorage.setItem("fomopad-board",JSON.stringify({at:Date.now(),tokens})); } catch {} updateBoard(); } catch(e) { if (run !== boardRequest || !$("#boardContent")) return; let cached = null; try { cached = JSON.parse(sessionStorage.getItem("fomopad-board") || "null"); } catch {} if (!q && cached?.tokens?.length && Date.now()-cached.at < 3_600_000) { tokens = cached.tokens; updateBoard(); document.querySelector(".board-stale")?.remove(); $("#boardContent").insertAdjacentHTML("beforebegin",'<p class="board-scope board-stale">Showing the last successful board update. Live refresh failed. <button class="secondary" id="retryBoard" type="button">Retry ↗</button></p>'); } else { $("#boardContent").innerHTML = '<div class="coin-list-empty"><div class="empty"><h3>Board unavailable</h3><p>' + esc(e.message) + '</p><button class="secondary" id="retryBoard">Retry</button></div></div>'; $("#sidebarTokens").innerHTML = '<div class="sidebar-empty">Feed unavailable.</div>'; } $("#retryBoard").onclick = () => loadBoard(q); } }
function updateBoard() {
  const group = (mode) => {
    if (mode === "watch") return tokens.filter(t => watch.has(t.mint));
    if (mode === "new") return tokens.filter(t => Date.now() - new Date(t.launchedAt).getTime() < 86_400_000);
    if (mode === "movers") return tokens.filter(t => Number(t.market?.volume24hUsd) > 0 && Number.isFinite(Number(t.market?.change24hPct)) && t.market?.change24hPct != null).sort((a,b) => Math.abs(Number(b.market.change24hPct)) - Math.abs(Number(a.market.change24hPct)));
    if (mode === "trending") return tokens.filter(t => Number(t.market?.volume24hUsd) > 0).sort((a,b) => Number(b.market.volume24hUsd) - Number(a.market.volume24hUsd));
    if (mode === "cap") return tokens.filter(t => Number(t.market?.marketCapUsd) > 0).sort((a,b) => Number(b.market.marketCapUsd) - Number(a.market.marketCapUsd));
    if (mode === "near") return tokens.filter(t => t.curve && !t.curve.migrated).sort((a,b) => b.curve.progressPercent - a.curve.progressPercent);
    if (mode === "rewards") return tokens.filter(t => Number(t.rewardPaidLamports) > 0).sort((a,b) => Number(b.rewardPaidLamports) - Number(a.rewardPaidLamports));
    return tokens;
  };
  const list = group(view);
  document.querySelectorAll("[data-tab]").forEach(b => { b.querySelector("span").textContent = group(b.dataset.tab).length; });
  const label = { watch:"No watchlist coins yet", new:"No launches in the last 24h", movers:"No active movers yet", trending:"No indexed volume yet", cap:"Market caps are awaiting indexing", near:"No curve readings yet", rewards:"No reward payouts yet" };
  $("#boardContent").innerHTML = list.length ? coinCards(list) : '<div class="coin-list-empty">' + empty($("#search")?.value ? "No matching coins" : label[view] || "No launches yet", view === "all") + '</div>';
  $("#sidebarTokens").innerHTML = tokens.length ? tokens.slice(0, 8).map(t => '<a class="sidebar-token" href="#token/' + esc(t.mint) + '"><img src="' + esc(t.image) + '" alt=""><span><b>' + esc(t.name) + '</b><small>$' + esc(t.symbol) + '</small></span><span class="sidebar-token-arrow">↗</span></a>').join('') : '<div class="sidebar-empty">No verified launches yet.<a href="#launch">Launch the first →</a></div>';
}
function discover() {
  view = "all";
  main.innerHTML = '<div class="shell"><div class="page-topline"><span>FOMOPAD / SOLANA</span><span><i class="online-dot"></i> MAINNET</span></div><div class="coin-list-head"><div><span class="eyebrow">DISCOVER / VERIFIED LAUNCHES</span><h1>Launched coins.</h1><p>Explore coins created on Fomopad. Each one has a verified Solana receipt.</p></div><a class="primary" href="#launch">Launch a coin ↗</a></div><div class="coin-toolbar"><div class="coin-filters" aria-label="Filter launched coins"><button type="button" data-tab="all" class="selected">All <span>0</span></button><button type="button" data-tab="movers">Movers <span>0</span></button><button type="button" data-tab="new">New <span>0</span></button><button type="button" data-tab="watch">Watchlist <span>0</span></button></div><label class="coin-search"><span>⌕</span><input id="search" placeholder="Filter coins…" aria-label="Search tokens"></label></div><div id="boardContent" class="coin-grid"><div class="coin-list-empty">' + empty("Loading launches", false) + '</div></div></div>';
  main.querySelector(".coin-filters").insertAdjacentHTML("beforeend", '<button type="button" data-tab="trending">Trending <span>0</span></button><button type="button" data-tab="cap">Market cap <span>0</span></button><button type="button" data-tab="near">Near graduation <span>0</span></button><button type="button" data-tab="rewards">Rewards paid <span>0</span></button>');
  main.querySelector(".coin-toolbar").insertAdjacentHTML("afterend", '<p class="board-scope">Filters rank the 50 most recent verified Fomopad launches. Market figures may await third-party indexing; curve progress comes from the DBC pool.</p>');
  $("#search").addEventListener("input", (() => { let timer; return (e) => { clearTimeout(timer); timer = setTimeout(() => loadBoard(e.target.value.trim()), 260); }; })());
  document.querySelectorAll("[data-tab]").forEach(b => b.onclick = () => { view = b.dataset.tab; document.querySelectorAll("[data-tab]").forEach(x => x.classList.toggle("selected", x === b)); updateBoard(); });
  loadBoard("");
}
function launch() {
  main.innerHTML = '<div class="shell"><div class="page-head"><div class="eyebrow">CREATE / 01</div><h1>Make it <em style="color:#ae9dff;font-style:normal">fomo.</em></h1><p class="lead">Give your coin a name, find its fomo address, and approve the mainnet launch in your wallet. The launch uses Meteora DBC. Buyers trade along a bonding curve before liquidity migrates to DAMM v2.</p></div><div class="launch-layout"><form class="panel form" id="launchForm"><h2>Coin details</h2><div class="form-grid"><div class="field span"><label>Coin image</label><label class="upload"><span class="upload-placeholder" id="imagePreview">✦</span><span><b>Choose an image</b><small>PNG, JPG, WEBP or GIF • under 350 KB after resizing</small></span><input id="coinImage" type="file" accept="image/png,image/jpeg,image/webp,image/gif" required></label></div><div class="field"><label for="coinName">Name</label><input id="coinName" maxlength="32" placeholder="The Next Big Thing" required></div><div class="field"><label for="coinSymbol">Ticker</label><input id="coinSymbol" maxlength="10" placeholder="FOMO" required></div><div class="field span"><label for="coinDescription">Description</label><textarea id="coinDescription" maxlength="800" placeholder="Tell everyone what this coin is about"></textarea></div><div class="field"><label for="website">Website · optional</label><input id="website" type="url" placeholder="https://..."></div><div class="field"><label for="xlink">X · optional</label><input id="xlink" type="url" placeholder="https://x.com/..."></div><div class="field span"><label for="telegram">Telegram · optional</label><input id="telegram" type="url" placeholder="https://t.me/..."></div></div><div class="form-divider"></div><div class="step-label"><span>02</span> THE CURVE</div><div class="curve-card"><label for="initialCapSol">Starting market cap · SOL</label><input id="initialCapSol" type="number" min="30" max="60" step="0.1" value="30" required><p>Minimum 30 SOL. The curve graduates when its quote reserve reaches 88.5766 SOL, then migrates to Meteora DAMM v2. DBC trading fee: 1%. DAMM v2 pool fee: 2%.</p><small>Market cap is a starting price estimate, not money deposited in the pool. The SOL value in USD changes with the SOL price.</small></div><div class="form-divider"></div><div class="step-label"><span>03</span> YOUR ADDRESS</div><div class="mint-box"><div><b id="mintText">•••• •••• •••• fomo</b><small id="mintHint">A prepared fomo mint is reserved for your signed-in wallet.</small></div><button class="secondary" id="grindBtn" type="button">Get fomo address ↗</button></div><p class="tiny">The mint signing key is generated ahead of time, encrypted on Fomopad, and used only to sign your exact launch transaction. Your wallet still approves the launch.</p><div class="form-divider"></div><div class="step-label"><span>04</span> APPROVE LAUNCH</div><div class="notice"><h3>Mainnet launch on Meteora DBC</h3><p>Your wallet creates the DBC config, token and pool in one transaction. It pays network and account rent; Fomopad adds no upfront launch fee. It routes 20% of the DBC non-protocol bonding fee share to its team treasury. After the curve fills, liquidity migrates to DAMM v2 with the creator allocation permanently locked. The coin appears here only after its chain receipt verifies.</p></div><div class="submit-row"><button type="submit" class="primary" id="submitLaunch">' + (wallet ? 'Sign & launch coin ↗' : 'Connect wallet to launch ↗') + '</button><p>You will review the transaction in your wallet.<br>There is no seed phrase or custody step.</p></div><div id="launchStatus"></div></form><aside><div class="panel side-card reward-card"><div class="mini-label">FEES & REWARDS</div><h3>Creator fees, clearly.</h3><label class="enabled-toggle" for="rewardMode"><div><b>Fomo trader rewards</b><p style="margin:6px 0 0">Send your DBC bonding fee share to verified Fomo buyers who still hold your coin.</p></div><input id="rewardMode" type="checkbox" aria-label="Enable Fomo trader rewards"><span class="switch" aria-hidden="true"></span></label><span class="badge-wait">CREATOR OPT-IN</span><div class="line"></div><p id="rewardLaunchNotice">Optional. Verified Fomo trade wallets share claimed bonding fees by current balance. Other traders receive no payout. This fee route cannot be changed after launch. After graduation, DAMM v2 fees remain with the creator locked position.</p><div id="rewardVaultStatus" class="reward-vault-status">Checking vault authority…</div><a class="side-link" href="#about">See the intended flow ↗</a></div><div class="panel side-card" style="margin-top:15px"><div class="mini-label">LAUNCH CHECKLIST</div><div class="reward-points"><div><span>01</span> Upload image and details</div><div><span>02</span> Reserve a real ...fomo mint</div><div><span>03</span> Review DBC config and sign</div><div><span>04</span> Verify pool on Solana</div></div></div></aside></div></div>';
  main.querySelector(".page-head .lead").textContent = "Give your coin a name, reserve its fomo address, then choose Meteora DBC or Stonk.fun before approving the mainnet transaction in your wallet.";
  const curveStep = [...document.querySelectorAll("#launchForm .step-label")].find(el => el.textContent.includes("THE CURVE"));
  curveStep?.insertAdjacentHTML("beforebegin", '<div class="step-label"><span>02</span> LAUNCH RAIL</div><div class="rail-picker" role="radiogroup" aria-label="Choose launch rail"><label class="rail-option" for="railDbc"><input id="railDbc" name="launchRail" type="radio" value="DBC" checked><span><b>Meteora DBC</b><small>Custom 30–60 SOL starting cap, DAMM v2 migration, and optional Fomo-only rewards.</small></span><em>FOMOPAD DEFAULT</em></label><label class="rail-option" for="railStonk"><input id="railStonk" name="launchRail" type="radio" value="STONK"><span><b>Stonk.fun</b><small>Stonk’s live SOL LaunchLab curve. Standard creator fees forward to your wallet.</small></span><em id="stonkRailState">CHECKING RAIL</em></label></div><p class="fee-route-lock">Both rails use a real Solana mint ending in fomo; Stonk.fun uses Token-2022. Your choice is permanent for this launch.</p><div class="form-divider"></div>');
  if (curveStep) curveStep.querySelector("span").textContent = "03";
  const dbcCurveCard = curveStep?.nextElementSibling;
  if (dbcCurveCard) { dbcCurveCard.id = "dbcCurveCard"; dbcCurveCard.insertAdjacentHTML("afterend", '<div class="curve-card hidden" id="stonkCurveCard"><label>Stonk.fun curve · SOL pair</label><p>Fomopad reads the active Stonk.fun LaunchLab platform, curve, and graduation raise when the transaction is built. The mint is Token-2022. Stonk.fun forwards its standard creator-fee share to your wallet.</p><small id="stonkTerms">Checking the live Stonk.fun launch rail…</small></div>'); }
  const addressStep = [...document.querySelectorAll("#launchForm .step-label")].find(el => el.textContent.includes("YOUR ADDRESS"));
  if (addressStep) addressStep.querySelector("span").textContent = "04";
  const approveStep = [...document.querySelectorAll("#launchForm .step-label")].find(el => el.textContent.includes("APPROVE LAUNCH"));
  approveStep?.insertAdjacentHTML("beforebegin", '<div class="step-label"><span>05</span> FEE DESTINATION</div><div class="fee-route-picker" role="radiogroup" aria-label="Choose where launch fees go"><label class="fee-route-option" for="creatorFees"><input id="creatorFees" name="feeRoute" type="radio" value="creator" checked><span class="fee-radio" aria-hidden="true"></span><span class="fee-route-copy"><b>Creator fees</b><small id="creatorFeeCopy">Receive 80% of the DBC non-protocol bonding fee share; 20% goes to the Fomopad team treasury. Claim your share from My launches.</small><em>DBC · WALLET-APPROVED CLAIM</em></span></label><label class="fee-route-option" for="rewardTraders"><input id="rewardTraders" name="feeRoute" type="radio" value="traders"><span class="fee-radio" aria-hidden="true"></span><span class="fee-route-copy"><b>Fomo traders of this coin</b><small>Automatically split DBC fees by verified Fomo buy amount. A buyer remains eligible after selling.</small><em>DBC · FOMO BUYS ONLY</em></span></label><label class="fee-route-option" for="rewardHolders"><input id="rewardHolders" name="feeRoute" type="radio" value="holders"><span class="fee-radio" aria-hidden="true"></span><span class="fee-route-copy"><b>Fomo traders who still hold</b><small>Only verified Fomo buyers with a positive token balance at payout. Split by current balance.</small><em>DBC · FOMO BUY + HOLD</em></span></label></div><p class="fee-route-lock" id="feeRouteLock">New DBC launches route 20% of the non-protocol bonding fee share to the Fomopad team treasury at 6eJteDb9ag7gZviL1kgcQvyLjhJtMMt62Dh31W6nbWhx. The other 80% follows your choice. This is fixed on-chain.</p><div class="form-divider"></div>');
  if (approveStep) approveStep.querySelector("span").textContent = "06";
  const rewardCard = document.querySelector(".reward-card");
  rewardCard?.querySelector(".enabled-toggle")?.remove();
  if (rewardCard?.querySelector("h3")) rewardCard.querySelector("h3").textContent = "Route fees at launch.";
  if (rewardCard?.querySelector(".side-link")) { rewardCard.querySelector(".side-link").href = "#dashboard"; rewardCard.querySelector(".side-link").textContent = "Manage & claim fees ↗"; }
  const checklist = document.querySelector(".reward-points");
  if (checklist) checklist.innerHTML = '<div><span>01</span> Upload image and details</div><div><span>02</span> Reserve a real ...fomo mint</div><div><span>03</span> Choose the fee destination</div><div><span>04</span> Review DBC config and sign</div><div><span>05</span> Verify pool on Solana</div>';
  let rewardRailReady = false, stonkRailReady = false;
  const stonkChoice = $("#railStonk");
  if (stonkChoice) stonkChoice.disabled = true;
  function updateRail() {
    const isStonk = document.querySelector('input[name="launchRail"]:checked')?.value === "STONK";
    $("#dbcCurveCard")?.classList.toggle("hidden", isStonk);
    $("#stonkCurveCard")?.classList.toggle("hidden", !isStonk);
    if ($("#initialCapSol")) { $("#initialCapSol").disabled = isStonk; $("#initialCapSol").required = !isStonk; }
    const creatorChoice = $("#creatorFees"), rewardChoices = [$("#rewardTraders"),$("#rewardHolders")];
    for (const choice of rewardChoices) if (choice) { choice.disabled = isStonk || !rewardRailReady; if (choice.disabled && choice.checked && creatorChoice) creatorChoice.checked = true; }
    if ($("#creatorFeeCopy")) $("#creatorFeeCopy").textContent = isStonk ? "Stonk.fun forwards its standard creator share to your wallet. Fomopad cannot apply its DBC treasury split on this rail." : "Receive 80% of the DBC non-protocol bonding fee share; 20% goes to the Fomopad team treasury. Claim your share from My launches.";
    const creatorRouteBadge = creatorChoice?.closest('.fee-route-option')?.querySelector('em');
    if (creatorRouteBadge) creatorRouteBadge.textContent = isStonk ? 'STONK · AUTOMATIC FORWARDING' : 'DBC · WALLET-APPROVED CLAIM';
    if ($("#feeRouteLock")) $("#feeRouteLock").textContent = isStonk ? "Stonk.fun forwards standard creator fees automatically. The 20% Fomopad treasury split applies to new DBC launches only." : "New DBC launches route 20% of the non-protocol bonding fee share to the Fomopad team treasury at 6eJteDb9ag7gZviL1kgcQvyLjhJtMMt62Dh31W6nbWhx. The other 80% follows your choice. This is fixed on-chain.";
    const notice = document.querySelector("#launchForm .notice");
    if (notice) notice.innerHTML = isStonk ? '<h3>Mainnet launch on Stonk.fun</h3><p>Your wallet creates a Token-2022 mint and Raydium LaunchLab pool using Stonk.fun’s live SOL curve accounts. Fomopad adds no launch fee and lists the coin only after the on-chain receipt and Stonk.fun adoption both verify.</p>' : '<h3>Mainnet launch on Meteora DBC</h3><p>Your wallet creates the DBC config, token and pool in one transaction. It pays network and account rent; Fomopad adds no upfront launch fee. It routes 20% of the DBC non-protocol bonding fee share to its team treasury. After the curve fills, liquidity migrates to DAMM v2 with the creator allocation permanently locked. The coin appears here only after its chain receipt verifies.</p>';
    if (rewardCard?.querySelector("h3")) rewardCard.querySelector("h3").textContent = isStonk ? "Stonk creator fees." : "Route fees at launch.";
    $("#rewardVaultStatus")?.classList.toggle("hidden", isStonk);
    if ($("#rewardLaunchNotice")) $("#rewardLaunchNotice").textContent = isStonk ? "Stonk.fun forwards standard creator fees automatically. The Fomopad 20% treasury split is unavailable on this rail." : "On new DBC launches, 20% of the non-protocol bonding fee share goes to the Fomopad team treasury; 80% follows your choice: creator claim, verified Fomo traders, or verified Fomo traders still holding. DAMM v2 fees remain with the creator locked position.";
    if (checklist) checklist.innerHTML = isStonk ? '<div><span>01</span> Upload image and details</div><div><span>02</span> Reserve a real ...fomo mint</div><div><span>03</span> Choose Stonk.fun</div><div><span>04</span> Review LaunchLab transaction</div><div><span>05</span> Verify Stonk.fun adoption</div>' : '<div><span>01</span> Upload image and details</div><div><span>02</span> Reserve a real ...fomo mint</div><div><span>03</span> Choose the fee destination</div><div><span>04</span> Review DBC config and sign</div><div><span>05</span> Verify pool on Solana</div>';
  }
  document.querySelectorAll('input[name="launchRail"]').forEach(input => input.addEventListener("change", updateRail));
  $("#coinSymbol").closest(".field").insertAdjacentHTML("afterend", '<div class="identity-preview field span" id="identityPreview" role="status">Choose a ticker to check the Fomopad registry. Similar names are shown as a warning.</div>');
  ["coinName","coinSymbol"].forEach(id => { $("#"+id).addEventListener("input", scheduleIdentityCheck); });
  $("#coinImage").onchange = async (e) => { const f = e.target.files?.[0]; if (!f) return; const img = $("#imagePreview"); img.outerHTML = '<img id="imagePreview" alt="Preview">'; $("#imagePreview").src = URL.createObjectURL(f); scheduleIdentityCheck(); };
  $("#grindBtn").onclick = reserveMint;
  $("#launchForm").onsubmit = submitLaunch;
  request("/api/rewards/vault").then(v => { const el = $("#rewardVaultStatus"), creator = $("#creatorFees"); rewardRailReady = v.state === "ready"; if (!rewardRailReady) { for (const choice of [$("#rewardTraders"),$("#rewardHolders")]) if (choice) choice.checked = false; if (creator) creator.checked = true; } if (el) el.innerHTML = (rewardRailReady ? "Fomo reward routes ready · " : v.state === "needs-funding" ? "Fomo reward routes need gas · " : "Automatic rewards are not active yet · ") + (v.authority ? '<a href="https://solscan.io/account/' + esc(v.authority) + '" target="_blank" rel="noopener">' + esc(v.authority) + ' ↗</a>' : '') + (v.state !== "unavailable" ? '<small>For reward claim and payout gas only. Balance: ' + (Number(v.balanceLamports) / 1e9).toFixed(4) + ' SOL</small>' : ''); updateRail(); }).catch(() => { const el = $("#rewardVaultStatus"), creator = $("#creatorFees"); rewardRailReady = false; if (el) el.textContent = "Fomo reward routes unavailable"; for (const choice of [$("#rewardTraders"),$("#rewardHolders")]) if (choice) { choice.checked = false; choice.disabled = true; } if (creator) creator.checked = true; updateRail(); });
  request("/api/stonk/terms").then(v => { stonkRailReady = v.available === true; if (stonkChoice) stonkChoice.disabled = !stonkRailReady; if ($("#stonkRailState")) $("#stonkRailState").textContent = stonkRailReady ? "LIVE · SOL PAIR" : "UNAVAILABLE"; if ($("#stonkTerms")) $("#stonkTerms").textContent = stonkRailReady ? "Live platform and curve verified · paired with " + (v.quote?.symbol || "SOL") + (v.raiseSol ? " · " + v.raiseSol + " SOL graduation raise" : " · graduation raise loaded at launch") + "." : "Stonk.fun SOL launches are unavailable right now."; }).catch(e => { if (stonkChoice) stonkChoice.disabled = true; if ($("#stonkRailState")) $("#stonkRailState").textContent = "UNAVAILABLE"; if ($("#stonkTerms")) $("#stonkTerms").textContent = e.message || "Stonk.fun rail unavailable"; });
  updateRail();
  const pending = localStorage.getItem("fomopad-pending");
  if (pending) { $("#launchStatus").innerHTML = '<div class="status-message">A previous transaction may still be confirming. <button type="button" class="secondary" id="retryConfirm">Check receipt ↗</button></div>'; $("#retryConfirm").onclick = retryConfirm; }
  if (minted) { $("#mintText").textContent = minted; $("#mintHint").textContent = "Reserved for " + short(wallet); $("#grindBtn").textContent = "Address ready ✓"; $("#grindBtn").disabled = true; }
}
async function reserveMint() {
  if (reserving || minted) return;
  if (!wallet) { openWallet("reserve"); return; }
  if (signedWallet !== wallet) { await signIn(); if (signedWallet !== wallet) return; }
  reserving = true;
  let retryQueued = false;
  const button = $("#grindBtn"); if (button) { button.disabled = true; button.textContent = "Reserving…"; }
  try {
    const result = await request("/api/vanity/reserve", {method:"POST",headers:{authorization:"Bearer " + authToken}});
    if (result.queued) { retryQueued = true; if (button) { button.disabled = true; button.textContent = "Waiting · #" + result.position; } if ($("#mintHint")) $("#mintHint").textContent = "Your wallet is queued. This page will reserve the next available fomo address automatically."; return; }
    if (wallet !== result.wallet || !result.mint.endsWith("fomo")) throw Error("Reserved address did not match your wallet");
    minted = result.mint;
    if ($("#mintText")) { $("#mintText").textContent = minted; $("#mintHint").textContent = "Reserved for " + short(wallet); }
    if (button) button.textContent = "Address ready ✓";
    toast("Your fomo address is ready: " + short(minted));
  } catch(e) { toast(e.message || "Could not reserve an address"); if (button) { button.disabled = false; button.textContent = "Try again ↗"; } }
  finally { reserving = false; if (retryQueued && !minted) setTimeout(reserveMint, 6000); }
}
async function imageData(file) {
  if (!file) throw Error("Select a coin image");
  if (!["image/png","image/jpeg","image/webp","image/gif"].includes(file.type)) throw Error("Select PNG, JPG, WEBP, or GIF");
  let b = file;
  if (file.size > 350_000) { const bitmap = await createImageBitmap(file); const scale = Math.min(1, 512 / Math.max(bitmap.width, bitmap.height)); const canvas = document.createElement("canvas"); canvas.width = Math.max(1,Math.round(bitmap.width*scale)); canvas.height = Math.max(1,Math.round(bitmap.height*scale)); canvas.getContext("2d").drawImage(bitmap,0,0,canvas.width,canvas.height); b = await new Promise(resolve => canvas.toBlob(resolve,"image/webp",.77)); bitmap.close(); }
  if (!b || b.size > 350_000) throw Error("Image is too large; choose a smaller one");
  const raw = new Uint8Array(await b.arrayBuffer()); let binary = ""; for(let i=0;i<raw.length;i+=8192) binary += String.fromCharCode(...raw.slice(i,i+8192));
  return { mime: b.type, data: btoa(binary) };
}
let identityTimer, identityRun = 0;
function scheduleIdentityCheck() { clearTimeout(identityTimer); identityTimer = setTimeout(previewIdentity, 380); }
async function identityCheck(name, symbol, image) {
  let imageSha256 = "";
  if (image) {
    const bytes = Uint8Array.from(atob(image.data), c => c.charCodeAt(0));
    imageSha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(c=>c.toString(16).padStart(2,"0")).join("");
  }
  return request("/api/identity/check", {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name,symbol,imageSha256,mint:minted || undefined})});
}
async function previewIdentity() {
  const el = $("#identityPreview"), symbol = $("#coinSymbol")?.value.trim(), name = $("#coinName")?.value.trim();
  if (!el) return;
  const run = ++identityRun;
  if (!symbol) { el.textContent = "Choose a ticker to check the Fomopad registry."; return; }
  el.textContent = "Checking ticker and artwork…";
  try {
    const file = $("#coinImage")?.files[0];
    const result = await identityCheck(name,symbol,file ? await imageData(file) : null);
    if (run !== identityRun || !$("#identityPreview")) return;
    const ticker = result.ticker.available ? "Ticker available on Fomopad" : "Ticker reserved on Fomopad";
    const picture = result.image ? (result.image.available ? "Exact artwork available" : "Exact artwork already used") : "Add artwork to check it";
    const similar = result.similarNames.length ? " · Similar name exists; check its mint before launch" : "";
    el.classList.toggle("identity-taken", !result.ticker.available || result.image?.available === false);
    el.textContent = ticker + " · " + picture + similar;
  } catch(e) { if (run === identityRun && $("#identityPreview")) el.textContent = e.message || "Identity check unavailable"; }
}
function status(s, error) { const el = $("#launchStatus"); if(el) el.innerHTML = '<div class="status-message' + (error ? ' error' : '') + '">' + esc(s) + '</div>'; }
async function retryConfirm() {
  const pending = JSON.parse(localStorage.getItem("fomopad-pending") || "null");
  if (!pending) return;
  const confirmPath = pending.protocol === "DBC" ? "/api/dbc/confirm" : pending.protocol === "STONK" ? "/api/stonk/confirm" : "/api/confirm";
  try { const result = await request(confirmPath, {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(pending)}); if (result.status === "live") { localStorage.removeItem("fomopad-pending"); location.hash = "#token/" + pending.mint; } else status(result.message || "Still awaiting on-chain confirmation. Check again shortly."); }
  catch(e) { status(e.message || "Receipt check failed",true); }
}
async function submitLaunch(e) {
  e.preventDefault();
  if (!wallet) { openWallet(); return; }
  if (!minted) { await reserveMint(); if (!minted) return; }
  if (typeof provider.signMessage !== "function" || typeof provider.signAndSendTransaction !== "function") { toast("This wallet needs signMessage and signAndSendTransaction support."); return; }
  const button = $("#submitLaunch"); button.disabled = true; button.textContent = "Preparing launch…";
  try {
    const protocol = document.querySelector('input[name="launchRail"]:checked')?.value || "DBC";
    if (protocol === "STONK" && $("#railStonk")?.disabled) throw Error("Stonk.fun SOL launches are unavailable right now.");
    const initialCapSol = protocol === "DBC" ? Number($("#initialCapSol").value) : null;
    if (protocol === "DBC" && (!Number.isFinite(initialCapSol) || initialCapSol < 30 || initialCapSol > 60 || Math.round(initialCapSol * 10) / 10 !== initialCapSol)) throw Error("Choose a starting cap from 30 to 60 SOL in 0.1 SOL steps.");
    const configSigner = protocol === "DBC" ? Keypair.generate() : null;
    const rewardScope = protocol === "DBC" ? document.querySelector('input[name="feeRoute"]:checked')?.value || "creator" : "creator";
    const draft = { protocol, config:configSigner?.publicKey.toBase58(), initialCapSol, rewardMode:protocol === "DBC" && rewardScope !== "creator", rewardScope, mint: minted, creator: wallet, name: $("#coinName").value.trim(), symbol: $("#coinSymbol").value.trim(), description: $("#coinDescription").value.trim(), website: $("#website").value.trim(), x: $("#xlink").value.trim(), telegram: $("#telegram").value.trim(), image: await imageData($("#coinImage").files[0]) };
    const identity = await identityCheck(draft.name,draft.symbol,draft.image);
    if (!identity.ticker.available) throw Error("Ticker is already reserved on Fomopad");
    if (identity.image?.available === false) throw Error("This exact coin image is already used on Fomopad");
    const payload = JSON.stringify(draft);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload)));
    const hash = [...digest].map(x => x.toString(16).padStart(2,"0")).join("");
    status("Approve the draft message in your wallet. This does not spend SOL.");
    const signed = await provider.signMessage(new TextEncoder().encode("Fomopad launch draft v1\n" + hash), "utf8");
    const signature = btoa(String.fromCharCode(...signed.signature));
    await request("/api/draft", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({payload,signature}) });
    status("Building the on-chain launch transaction…");
    const prepPath = protocol === "DBC" ? "/api/dbc/prepare" : "/api/stonk/prepare";
    const prep = await request(prepPath, { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({mint:minted,creator:wallet}) });
    if (protocol === "DBC" && (prep.program !== "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN" || prep.config !== draft.config || prep.initialCapSol !== initialCapSol || prep.migrationThresholdSol !== 88.576623265 || prep.rewardMode !== draft.rewardMode || prep.rewardScope !== draft.rewardScope || prep.treasuryBps !== 2000 || prep.treasuryWallet !== "6eJteDb9ag7gZviL1kgcQvyLjhJtMMt62Dh31W6nbWhx" || !prep.feeClaimer)) throw Error("DBC launch settings changed. Launch stopped.");
    if (protocol === "STONK" && (prep.mode !== "standard" || prep.quoteMint !== "So11111111111111111111111111111111111111112" || prep.tokenProgram !== "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" || prep.feeDestination !== wallet || !prep.pool || !prep.config || !prep.platform || !prep.allowConfig || !prep.curveRule)) throw Error("Stonk.fun launch settings changed. Launch stopped.");
    const tx = Transaction.from(Uint8Array.from(atob(prep.transaction),c=>c.charCodeAt(0)));
    const launchIx = protocol === "DBC" ? tx.instructions : tx.instructions.filter(ix=>ix.programId.toBase58() === prep.program);
    const expectedAccounts = protocol === "DBC" ? [minted,draft.config,prep.pool,prep.feeClaimer] : [minted,prep.pool,prep.config,prep.platform,prep.quoteMint,prep.allowConfig,prep.curveRule];
    if (tx.instructions.length !== 2 || launchIx.length !== (protocol === "DBC" ? 2 : 1) || (protocol === "DBC" ? tx.instructions.some(ix=>ix.programId.toBase58() !== prep.program) : tx.instructions.filter(ix=>ix.programId.toBase58() === "ComputeBudget111111111111111111111111111111").length !== 1) || tx.feePayer.toBase58() !== wallet || !expectedAccounts.every(account=>tx.instructions.some(ix=>ix.keys.some(k=>k.pubkey.toBase58() === account))) || !tx.instructions.some(ix=>ix.keys.some(k=>k.pubkey.toBase58() === minted && k.isSigner))) throw Error((protocol === "DBC" ? "DBC" : "Stonk.fun") + " transaction accounts do not match the launch");
    if (!tx.signatures.some(s => s.publicKey.toBase58() === minted && s.signature) || !tx.verifySignatures(false)) throw Error("Prepared mint signature did not verify");
    if (configSigner) tx.partialSign(configSigner);
    if (!tx.verifySignatures(false)) throw Error("Launch signer verification failed");
    status("Review and approve the mainnet transaction in your wallet."); button.textContent = "Waiting for wallet…";
    const sent = await provider.signAndSendTransaction(tx);
    const chainSig = typeof sent === "string" ? sent : sent.signature;
    if (!chainSig) throw Error("Wallet did not return a transaction signature");
    localStorage.setItem("fomopad-pending", JSON.stringify({protocol,mint:minted,creator:wallet,signature:chainSig}));
    status("Transaction sent. Waiting for Solana to confirm: " + short(chainSig));
    button.textContent = "Confirming on Solana…";
    const confirmPath = protocol === "DBC" ? "/api/dbc/confirm" : "/api/stonk/confirm";
    for(let i=0;i<(protocol === "STONK" ? 80 : 24);i++) {
      const result = await request(confirmPath, { method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({mint:minted,creator:wallet,signature:chainSig}) });
      if (result.status === "live") { localStorage.removeItem("fomopad-pending"); status("Launch verified on Solana! Opening your coin."); location.hash = "#token/" + minted; return; }
      await new Promise(resolve=>setTimeout(resolve,1800));
    }
    status("The transaction was sent, but verification is still pending. Check the explorer and return here to retry. Signature: " + chainSig);
  } catch (err) { status(err.message || "Launch failed", true); }
  finally { button.disabled = false; button.textContent = "Sign & launch coin ↗"; }
}
async function dashboard() {
  const identity = signedWallet || wallet;
  main.innerHTML = '<div class="shell"><div class="page-head"><div class="eyebrow">CREATOR / YOUR COINS</div><h1>Your launches.</h1><p class="lead">Verified coins launched by your ' + (signedWallet ? 'signed in' : 'connected') + ' wallet, with direct transaction receipts.</p></div><div id="dashContent" class="panel">' + (identity ? empty("Loading your launches",false) : '<div class="dashboard-cta"><div><h2>Sign in to see your coins.</h2><p>Approve a wallet message to keep your account available on this device.</p></div><button class="primary" id="dashConnect">Sign in ↗</button></div>') + '</div></div>';
  if (!identity) { $("#dashConnect").onclick = signIn; return; }
  try { const data = await request("/api/creator/" + identity); const el = $("#dashContent"); if (!el) return; el.className = "coin-grid"; el.innerHTML = data.tokens.length ? coinCards(data.tokens) : '<div class="coin-list-empty">' + empty("Nothing here yet",false) + '</div>'; if (data.tokens.length) { el.insertAdjacentHTML("beforebegin", '<section class="panel creator-claim"><div class="eyebrow">CREATOR / FEES</div><h2>Claim fees.</h2><p>DBC coins have individual claims. Stonk.fun standard LaunchLab creator fees forward to the launch wallet automatically. Connect and sign in with the launch wallet to see your fee routes.</p><a class="primary" href="#fees">Open Claim fees ↗</a><div id="dashboardFees" class="dashboard-fees"></div></section>'); renderFeeRows(data.tokens,$("#dashboardFees")); } } catch(e) { const el = $("#dashContent"); if (el) el.innerHTML = empty("Could not load your launches",false); toast(e.message); }
}
function renderFeeRows(tokens, host) {
  const rows = tokens.map(t => {
    const row = document.createElement("div"); row.className = "dashboard-fee-row";
    row.textContent = t.symbol + " · checking fee status…";
    host.appendChild(row); return row;
  });
  let next = 0;
  const worker = async () => {
    while (next < tokens.length && host.isConnected) {
      const i = next++;
      await renderCreatorClaimPanel(tokens[i],rows[i]);
    }
  };
  void Promise.all(Array.from({length:Math.min(3,tokens.length)},worker));
}
async function feesPage() {
  const identity = signedWallet || wallet;
  main.innerHTML = '<div class="shell"><div class="page-head"><div class="eyebrow">CREATOR / FEES</div><h1>Claim fees.</h1><p class="lead">Review your on-chain creator fee balances for DBC and Stonk.fun launches.</p></div><section class="panel creator-claim"><div class="eyebrow">YOUR WALLET</div><h2>' + (identity ? esc(short(identity)) : 'Connect to view your claims.') + '</h2><p>DBC creator claims are per coin. Stonk.fun standard LaunchLab fees forward to the creator wallet automatically. Eligible older Stonk vaults, if any, appear here. Fomo trader rewards distribute automatically on DBC.</p>' + (identity ? '<div id="feePageRows" class="dashboard-fees">Loading your fee balances…</div>' : '<button class="primary" type="button" id="feesConnect">Claim fees ↗</button>') + '</section></div>';
  if (!identity) { $("#feesConnect").onclick = signIn; return; }
  try { const data = await request("/api/creator/" + identity); const host = $("#feePageRows"); if (!host) return; host.textContent = ""; if (data.tokens.length) renderFeeRows(data.tokens,host); else host.innerHTML = '<p>No verified launches for this wallet yet.</p>'; }
  catch(e) { const host = $("#feePageRows"); if (host) host.textContent = "Could not load fee balances: " + e.message; }
}
let chartSession = null;
function closeChart() {
  if (!chartSession) return;
  chartSession.closed = true;
  clearInterval(chartSession.timer);
  chartSession.chart?.remove();
  chartSession = null;
}
function chartPrice(value) {
  if (!Number.isFinite(value) || value <= 0) return "—";
  return "$" + new Intl.NumberFormat("en-US", { maximumFractionDigits: value < .0001 ? 10 : value < 1 ? 8 : 4, minimumFractionDigits: value < .0001 ? 6 : 0 }).format(value);
}
async function refreshChart(session, quiet = false) {
  if (session.closed) return;
  const run = ++session.run;
  const canvas = $("#chartCanvas"), quote = $("#chartQuote"), tabs = document.querySelectorAll("[data-period]");
  if (!canvas || !quote) return;
  tabs.forEach(b => { b.classList.toggle("selected", b.dataset.period === session.period); b.setAttribute("aria-pressed", b.dataset.period === session.period ? "true" : "false"); });
  if (!quiet && !session.chart) canvas.innerHTML = '<div class="chart-empty"><div>Loading market candles…</div></div>';
  try {
    const data = await request("/api/tokens/" + encodeURIComponent(session.mint) + "/chart?period=" + session.period);
    if (session.closed || run !== session.run || location.hash !== "#token/" + session.mint) return;
    const bars = data.candles || [];
    if (!bars.length) {
      if (session.chart) { session.chart.remove(); session.chart = null; }
      canvas.innerHTML = '<div class="chart-empty"><div><b>' + (data.state === "awaiting-index" ? 'Waiting for market indexing' : 'Waiting for the first trades') + '</b>The chart starts as soon as this pool has indexed on-chain trades. No prices are simulated.</div></div>';
      quote.textContent = "No candle data yet";
      return;
    }
    const first = bars[0], last = bars[bars.length - 1];
    const change = (last.close / first.open - 1) * 100;
    quote.innerHTML = '<strong>' + chartPrice(last.close) + '</strong><span class="chart-change ' + (change >= 0 ? 'up' : 'down') + '">' + (change >= 0 ? '+' : '') + change.toFixed(2) + '% shown</span><span>' + bars.length + ' candle' + (bars.length === 1 ? '' : 's') + ' · USD</span>';
    if (!session.chart) {
      const lib = await import("https://esm.sh/lightweight-charts@5.2.0?bundle");
      if (session.closed || run !== session.run || location.hash !== "#token/" + session.mint) return;
      canvas.replaceChildren();
      session.chart = lib.createChart(canvas, {
        autoSize: true, layout: { background: { type: "solid", color: "#0b0a15" }, textColor: "#9390a4", fontFamily: "Outfit" },
        grid: { vertLines: { color: "#1b1a26" }, horzLines: { color: "#1b1a26" } },
        rightPriceScale: { borderColor: "#2b2938", scaleMargins: { top: .07, bottom: .25 } },
        timeScale: { borderColor: "#2b2938", timeVisible: true, secondsVisible: false, barSpacing: 10, rightOffset: 8 },
        crosshair: { vertLine: { color: "#514e72", labelBackgroundColor: "#33314c" }, horzLine: { color: "#514e72", labelBackgroundColor: "#33314c" } },
      });
      session.candles = session.chart.addSeries(lib.CandlestickSeries, { upColor: "#65c99d", downColor: "#e2748e", borderVisible: false, wickUpColor: "#65c99d", wickDownColor: "#e2748e", priceFormat: { type: "price", precision: 10, minMove: 0.0000000001 } });
      session.volume = session.chart.addSeries(lib.HistogramSeries, { color: "#575387", priceFormat: { type: "volume" }, priceScaleId: "", priceLineVisible: false, lastValueVisible: false });
      session.chart.priceScale("").applyOptions({ scaleMargins: { top: .8, bottom: 0 } });
    }
    session.candles.setData(bars.map(b => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close })));
    session.volume.setData(bars.map(b => ({ time: b.time, value: b.volume, color: b.close >= b.open ? "#3869559a" : "#7843579a" })));
    if (!session.fitted || session.fitted !== session.period) { session.chart.timeScale().fitContent(); session.fitted = session.period; }
  } catch (e) {
    if (session.closed || run !== session.run) return;
    if (!session.chart) canvas.innerHTML = '<div class="chart-empty"><div><b>Chart temporarily unavailable</b>Market data could not be loaded. You can try another interval or open the pool chart below.</div></div>';
    quote.textContent = "Market data temporarily unavailable";
  }
}
function mountChart(mint) {
  closeChart();
  const session = { mint, period: "1m", run: 0, closed: false, chart: null, candles: null, volume: null, timer: null, fitted: null };
  chartSession = session;
  document.querySelectorAll("[data-period]").forEach(b => b.onclick = () => {
    if (session.period === b.dataset.period) return;
    session.period = b.dataset.period;
    session.fitted = null;
    refreshChart(session);
  });
  refreshChart(session);
  session.timer = setInterval(() => { if (!document.hidden) refreshChart(session, true); }, 60_000);
}
async function tokenDetail(mint) {
  main.innerHTML = '<div class="shell"><div class="page-head"><div class="eyebrow">TOKEN / ON-CHAIN</div><h1>Loading coin…</h1></div></div>';
  try {
    const {token:t,curve,graduated,market} = await request("/api/tokens/" + encodeURIComponent(mint));
    const fomo = "https://fomo.family/tokens/solana/" + encodeURIComponent(t.mint);
    const jupiter = "https://jup.ag/swap?buy=" + encodeURIComponent(t.mint) + "&sell=So11111111111111111111111111111111111111112";
    const isDbc = t.protocol === "DBC";
    const isStonk = t.protocol === "STONK";
    const curveAddress = (isDbc || isStonk) ? t.pool : curve;
    const curveSummary = isDbc ? (curve ? Math.round(curve.progress * 100) + "% to migration · " + curve.quoteReserveSol.toFixed(2) + " / " + curve.migrationThresholdSol.toFixed(2) + " SOL" : "DBC curve state unavailable") : isStonk ? "Stonk.fun · Raydium LaunchLab · SOL pair" : "Pump bonding curve";
    main.innerHTML = '<div class="shell"><div class="page-head"><div class="eyebrow">DISCOVER / VERIFIED TOKEN</div><a class="side-link" href="#discover">← Back to Discover</a></div><div class="panel detail-head"><img src="' + esc(t.image) + '" alt=""><div><h2>' + esc(t.name) + ' <span style="color:#a497bb;font-size:18px">$' + esc(t.symbol) + '</span></h2><p>Launched ' + age(t.launchedAt) + ' ago · ' + (graduated === true ? 'Curve completed' : graduated === false ? 'Bonding curve' : 'Curve state unavailable') + '</p></div><button class="secondary" style="margin-left:auto" id="watchBtn">' + (watch.has(t.mint) ? '★ Watching' : '☆ Watchlist') + '</button></div><section class="panel token-chart" aria-label="Coin price chart"><div class="chart-top"><div class="chart-heading"><h3>Price chart</h3><span>On-chain pool · USD</span></div><div class="chart-tabs" aria-label="Chart timeframe"><button type="button" data-period="1m" class="selected" aria-pressed="true">1m</button><button type="button" data-period="5m" aria-pressed="false">5m</button><button type="button" data-period="15m" aria-pressed="false">15m</button><button type="button" data-period="1h" aria-pressed="false">1h</button><button type="button" data-period="4h" aria-pressed="false">4h</button><button type="button" data-period="1d" aria-pressed="false">1d</button></div></div><div class="chart-quote" id="chartQuote">Loading market data…</div><div class="chart-canvas" id="chartCanvas"><div class="chart-empty"><div>Loading market candles…</div></div></div><div class="chart-foot"><span>Market candles by GeckoTerminal · refreshes every minute</span><a href="https://www.geckoterminal.com/solana/pools/' + esc(market?.pair || curveAddress) + '" target="_blank" rel="noopener">Open pool on GeckoTerminal ↗</a></div></section><div class="detail-grid"><div class="panel detail-body"><h3>About this coin</h3><p style="line-height:1.7;color:#ada7bb;min-height:60px">' + esc(t.description || 'No description provided by the creator.') + '</p><div class="kv"><span>Price</span><b>' + money(market?.priceUsd) + (market ? ' · DEX Screener' : ' · waiting for index') + '</b></div><div class="kv"><span>24h volume</span><b>' + money(market?.volume24hUsd) + '</b></div><div class="kv"><span>Liquidity</span><b>' + money(market?.liquidityUsd) + '</b></div><div class="kv"><span>Mint</span><b>' + esc(t.mint) + '</b></div><div class="kv"><span>Creator</span><a target="_blank" rel="noopener" href="https://solscan.io/account/' + esc(t.creator) + '">' + esc(t.creator) + ' ↗</a></div><div class="kv"><span>Curve / pool</span><a target="_blank" rel="noopener" href="https://solscan.io/account/' + esc(curveAddress) + '">' + esc(curveAddress) + ' ↗</a></div><div class="kv"><span>Receipt</span><a target="_blank" rel="noopener" href="https://solscan.io/tx/' + esc(t.signature) + '">' + esc(short(t.signature)) + ' ↗</a></div><div class="kv"><span>Bonding</span><b>' + esc(curveSummary) + '</b></div><div class="kv"><span>Rewards</span><b>' + (t.rewardMode ? 'Fomo verified · DBC bonding fees' : 'Creator fees') + '</b></div><div class="link-row"><a href="' + esc(jupiter) + '" target="_blank" rel="noopener">Check Jupiter quote ↗</a><a href="' + esc(fomo) + '" target="_blank" rel="noopener">Check Fomo ↗</a><a href="https://dexscreener.com/solana/' + esc(t.mint) + '" target="_blank" rel="noopener">Chart & trades ↗</a><a href="https://solscan.io/token/' + esc(t.mint) + '" target="_blank" rel="noopener">Holders ↗</a>' + (t.website ? '<a href="' + esc(t.website) + '" target="_blank" rel="noopener">Website ↗</a>' : '') + (t.x ? '<a href="' + esc(t.x) + '" target="_blank" rel="noopener">X ↗</a>' : '') + '</div></div><div class="side-stack"><div class="panel side-card"><div class="mini-label">THE ADDRESS</div><div class="suffix" style="font-size:24px">' + esc(short(t.mint)) + '</div><p>The last four characters are part of the mint address itself.</p></div><div class="panel side-card reward-card"><div class="mini-label">ABOUT THE ROUTE</div><h3>Trade the curve.</h3><p>The DBC pool trades on Meteora before migration. Jupiter may route to it once indexed; verify the actual quote before signing. Fomo availability is independent.</p><a href="' + esc(jupiter) + '" class="side-link" target="_blank" rel="noopener">Open Jupiter swap ↗</a></div></div></div></div>';
    mountChart(t.mint);
    graduationTracker(t,curve);
    main.querySelector(".detail-body")?.insertAdjacentHTML("beforeend", '<section class="coin-safety"><span class="eyebrow">COIN / RECEIPTS</span><h3>Launch details</h3><div class="kv"><span>Launch rail</span><b>' + esc(isDbc ? "Meteora DBC" : isStonk ? "Stonk.fun LaunchLab" : t.protocol) + '</b></div><div class="kv"><span>Fee route</span><b>' + esc(t.rewardMode ? t.rewardScope === "traders" ? "Verified Fomo buyers" : "Verified Fomo buyers still holding" : isStonk ? "Stonk creator fee forwarding" : "Creator wallet claim") + '</b></div>' + (t.treasuryBps ? '<div class="kv"><span>Team treasury</span><a target="_blank" rel="noopener" href="https://solscan.io/account/6eJteDb9ag7gZviL1kgcQvyLjhJtMMt62Dh31W6nbWhx">20% of DBC non-protocol bonding fee share ↗</a></div>' : '') + '<div class="kv"><span>Launch receipt</span><a href="https://solscan.io/tx/' + esc(t.signature) + '" target="_blank" rel="noopener">View on Solscan ↗</a></div><div class="kv"><span>Mint authorities</span><a href="https://solscan.io/token/' + esc(t.mint) + '" target="_blank" rel="noopener">Check on Solscan ↗</a></div><div class="kv"><span>Creator profile</span><a href="#creator/' + esc(t.creator) + '">View launches ↗</a></div><p class="safety-note">Review the mint address and current authorities on-chain before trading. Fomopad verifies the launch receipt; this panel does not assign a risk score.</p></section>');
    const rewardLabel = [...main.querySelectorAll(".detail-body .kv")].find(el => el.firstElementChild?.textContent === "Rewards")?.querySelector("b");
    if (rewardLabel) rewardLabel.textContent = t.rewardMode ? (t.rewardScope === "traders" ? "Verified Fomo traders · by buy amount" : "Verified Fomo traders still holding · by balance") : isStonk ? "Stonk creator fees · automatic forwarding" : "DBC creator fees · wallet claim";
    if (isStonk) { const routeCopy = document.querySelector(".side-stack .reward-card p"); if (routeCopy) routeCopy.textContent = "This coin launched through Stonk.fun on Raydium LaunchLab. Stonk.fun forwards its standard creator-fee share to the launch wallet automatically. Jupiter and market charts appear after indexing; Fomo availability is independent."; }
    if (t.rewardMode) renderRewardPanel(t);
    if (isDbc || isStonk) renderCreatorClaimPanel(t);
    feeProof(t);
    if ((isDbc && !t.rewardMode) || isStonk) { $("#watchBtn")?.insertAdjacentHTML("beforebegin", '<button class="primary" type="button" id="jumpClaim">' + (isStonk ? 'Fee status ↗' : 'Claim fees ↗') + '</button>'); $("#jumpClaim")?.addEventListener("click", () => $("#coinClaimPanel")?.scrollIntoView({behavior:"smooth",block:"center"})); }
    $("#watchBtn").onclick = () => { if(watch.has(t.mint)) watch.delete(t.mint); else watch.add(t.mint); localStorage.setItem("fomopad-watch",JSON.stringify([...watch])); $("#watchBtn").textContent=watch.has(t.mint)?'★ Watching':'☆ Watchlist'; };
  } catch(e) { main.innerHTML = '<div class="shell"><div class="page-head"><h1>Coin unavailable.</h1><p class="lead">' + esc(e.message) + '</p><a class="secondary" href="#discover">Back to Discover</a></div></div>'; }
}
async function renderCreatorClaimPanel(t, host = null) {
  const panel = host || document.createElement("section");
  if (!host) panel.className = "panel creator-claim";
  if (!host) panel.id = "coinClaimPanel";
  panel.innerHTML = '<div class="eyebrow">CREATOR / FEES</div><h2>Claim fees.</h2><p>Checking fee route and on-chain accrual…</p>';
  if (!host) main.querySelector(".shell")?.appendChild(panel);
  const refresh = async () => {
    const state = await request("/api/creator-fees/" + encodeURIComponent(t.mint));
    if (!panel.isConnected) return;
    const amount = (Number(state.claimableQuoteLamports) / 1e9).toFixed(6);
    if (state.mode === "claim" || state.mode === "stonk-claim") {
      const stonk = state.mode === "stonk-claim";
      const hasFees = BigInt(state.claimableQuoteLamports) > 0n;
      const canClaim = wallet === t.creator && signedWallet === t.creator && !!authToken;
      panel.innerHTML = '<div class="eyebrow">' + (stonk ? 'STONK.FUN / SHARED CREATOR VAULT' : 'DBC / CREATOR FEE CLAIM') + '</div><h2>' + esc(t.symbol) + ' · claim fees</h2><p>' + (stonk ? 'One Raydium LaunchLab claim sweeps the creator wallet’s shared SOL-pair vault across its Stonk.fun launches. The payout arrives as WSOL in the creator’s token account.' : 'This coin routes its DBC bonding fee share to the creator wallet.') + ' <span class="claim-balance">' + esc(short(t.creator)) + '</span>. Network and token-account rent may apply.</p><div class="claim-actions"><strong class="claim-balance">' + amount + (stonk ? ' WSOL' : ' SOL') + ' claimable</strong><button class="primary" type="button" id="claimFees" ' + (hasFees ? '' : 'disabled') + '>' + 'Claim fees ↗' + '</button><a class="side-link" href="' + (host ? '#token/' + esc(t.mint) : '#fees') + '">' + (host ? 'View coin ↗' : 'View all fees ↗') + '</a></div><div class="claim-state" id="claimState">' + (hasFees ? canClaim ? 'Review the claim transaction in your wallet.' : wallet !== t.creator ? 'Connect and sign in with the launch creator wallet to claim.' : 'Sign in with the launch creator wallet to claim.' : 'No fees have accrued yet.') + '</div>';
      panel.querySelector("#claimFees")?.addEventListener("click", () => claimCreatorFees(t,panel,refresh));
    } else {
      panel.innerHTML = '<div class="eyebrow">CREATOR / FEES</div><h2>' + esc(t.symbol) + ' · ' + (state.mode === "distribution" ? 'Fomo trader rewards run automatically.' : state.mode === "automatic" ? 'Stonk.fun forwards creator fees automatically.' : 'Fee claim is unavailable here.') + '</h2><p>' + esc(state.explanation) + '</p><a class="side-link" href="' + (host ? '#token/' + esc(t.mint) : '#fees') + '">' + (host ? 'View coin ↗' : 'View all fees ↗') + '</a>';
    }
  };
  try { await refresh(); } catch(e) { if (panel.isConnected) panel.innerHTML = '<div class="eyebrow">CREATOR / FEES</div><h2>Fee status unavailable.</h2><p>' + esc(e.message) + '</p><button type="button" class="secondary" id="retryFees">Retry ↗</button>'; panel.querySelector("#retryFees")?.addEventListener("click", refresh); }
}
async function claimCreatorFees(t,panel,refresh) {
  const button = panel.querySelector("#claimFees"), state = panel.querySelector("#claimState");
  if (!button || !state) return;
  if (wallet !== t.creator) { openWallet("signin"); return; }
  if (signedWallet !== t.creator || !authToken) { await signIn(); if (signedWallet === t.creator && panel.isConnected) refresh(); return; }
  if (!provider?.signAndSendTransaction) { state.textContent = "This wallet cannot sign a Solana transaction."; return; }
  button.disabled = true; button.textContent = "Preparing claim…";
  try {
    const prep = await request("/api/creator-fees/" + encodeURIComponent(t.mint) + "/prepare", { method:"POST", headers:{authorization:"Bearer " + authToken} });
    const tx = Transaction.from(Uint8Array.from(atob(prep.transaction), c => c.charCodeAt(0)));
    const ataProgram = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", tokenProgram = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
    if (prep.creator !== wallet || prep.pool !== t.pool || BigInt(prep.estimatedQuoteLamports) <= 0n || tx.feePayer?.toBase58() !== wallet || tx.instructions.some(ix => ix.keys.some(k => k.isSigner && k.pubkey.toBase58() !== wallet))) throw Error("Fee claim settings changed");
    if (t.protocol === "STONK") {
      const wrappedSol = "So11111111111111111111111111111111111111112";
      const receiver = PublicKey.findProgramAddressSync([new PublicKey(wallet).toBuffer(),new PublicKey(tokenProgram).toBuffer(),new PublicKey(wrappedSol).toBuffer()],new PublicKey(ataProgram))[0].toBase58();
      const vault = PublicKey.findProgramAddressSync([new PublicKey(wallet).toBuffer(),new PublicKey(wrappedSol).toBuffer()],new PublicKey(prep.program))[0].toBase58();
      const vaultAuth = PublicKey.findProgramAddressSync([new TextEncoder().encode("creator_fee_vault_auth_seed")],new PublicKey(prep.program))[0].toBase58();
      const ix = tx.instructions[1], ata = tx.instructions[0];
      const expected = [wallet,vaultAuth,vault,receiver,wrappedSol,tokenProgram,"11111111111111111111111111111111",ataProgram];
      if (prep.mode !== "stonk-claim" || prep.program !== "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj" || prep.receiver !== receiver || prep.vault !== vault || prep.quoteMint !== wrappedSol || prep.scope !== "shared-creator-vault" || tx.instructions.length !== 2 || ata?.programId.toBase58() !== ataProgram || ata.data.length !== 1 || ata.data[0] !== 1 || ata.keys.map(k=>k.pubkey.toBase58()).join() !== [wallet,receiver,wallet,wrappedSol,"11111111111111111111111111111111",tokenProgram].join() || ix?.programId.toBase58() !== prep.program || ix.data.length !== 8 || ![26,97,138,203,132,171,141,252].every((n,i)=>ix.data[i]===n) || ix.keys.map(k=>k.pubkey.toBase58()).join() !== expected.join() || !ix.keys[0].isSigner || tx.instructions.some(x=>x.keys.some(k=>k.isSigner && k.pubkey.toBase58()!==wallet))) throw Error("Unexpected Stonk.fun fee claim transaction. Nothing was signed.");
    } else {
      const allowed = new Set([prep.program,ataProgram,tokenProgram]);
      const claim = tx.instructions.filter(ix => ix.programId.toBase58() === prep.program);
      const discriminator = [82,220,250,189,3,85,107,45];
      if (prep.mode !== "claim" || prep.receiver !== wallet || prep.program !== "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN" || tx.instructions.some(ix => !allowed.has(ix.programId.toBase58())) || claim.length !== 1 || claim[0].data.length !== 24 || !discriminator.every((n,i) => claim[0].data[i] === n) || !claim[0].keys.some(k => k.pubkey.toBase58() === prep.pool) || !claim[0].keys.some(k => k.pubkey.toBase58() === wallet && k.isSigner) || claim[0].data.readBigUInt64LE(8) !== 0n || claim[0].data.readBigUInt64LE(16) !== BigInt(prep.estimatedQuoteLamports) || tx.instructions.filter(ix => ix.programId.toBase58() === tokenProgram).some(ix => ix.data[0] !== 9 || ix.keys[1]?.pubkey.toBase58() !== wallet)) throw Error("Unexpected DBC fee claim transaction. Nothing was signed.");
    }
    state.textContent = "Approve the " + (t.protocol === "STONK" ? "Stonk.fun" : "DBC") + " claim in your wallet…"; button.textContent = "Waiting for wallet…";
    const sent = await provider.signAndSendTransaction(tx);
    const signature = typeof sent === "string" ? sent : sent.signature;
    if (!signature) throw Error("Wallet did not return a claim signature");
    state.innerHTML = 'Sent · <a href="https://solscan.io/tx/' + esc(signature) + '" target="_blank" rel="noopener">View receipt ↗</a> · confirming…';
    button.textContent = "Confirming…";
    let confirmed = false;
    for (let attempt = 0; attempt < 12; attempt++) {
      const result = await request("/api/creator-fees/" + encodeURIComponent(t.mint) + "/confirm", { method:"POST", headers:{authorization:"Bearer " + authToken,"content-type":"application/json"}, body:JSON.stringify({signature}) });
      if (result.status === "confirmed") { confirmed = true; break; }
      await new Promise(resolve => setTimeout(resolve, 2500));
    }
    if (!confirmed) { button.textContent = "Check again later"; state.innerHTML = 'Claim submitted. <a href="https://solscan.io/tx/' + esc(signature) + '" target="_blank" rel="noopener">Check its Solana receipt ↗</a>'; return; }
    toast("Creator fees claimed on Solana"); await refresh();
  } catch(e) { if (state.isConnected) state.textContent = e.message || "Claim cancelled"; if (button.isConnected) { button.disabled = false; button.textContent = "Claim fees ↗"; } }
}
let rewardTimer = null;
function renderRewardPanel(t) {
  const panel = document.createElement("section");
  panel.className = "panel reward-panel";
  const traders = t.rewardScope === "traders";
  panel.innerHTML = '<div class="eyebrow">AUTOMATIC / FOMO TRADER REWARDS</div><h2>' + (traders ? 'Fomo trade, then share the fees.' : 'Fomo buy and hold. Rewards arrive automatically.') + '</h2><p>Fomopad watches this coin\'s DBC pool for Fomo co-signed buys. ' + (traders ? 'Verified buyer wallets split claimed fees by cumulative verified buy amount, even if they later sell.' : 'Verified buyer wallets must still hold the coin at each payout and split claimed fees by current balance.') + ' The reward authority claims and pays automatically; traders do not submit a claim.</p><div id="rewardResults">Checking on-chain rewards…</div><small>Only this coin\'s verified Fomo buys qualify. DBC bonding fees only; post-migration DAMM v2 fees belong to the creator\'s locked position. Fomo controls coin availability in its app.</small>';
  main.querySelector(".shell").appendChild(panel);
  const update = async () => {
    if (!document.getElementById("rewardResults")) return;
    try {
      const v = await request("/api/rewards/" + encodeURIComponent(t.mint) + "/status");
      const paid = v.payouts.filter(x => x.status === "paid" && x.kind !== "team-treasury");
      $("#rewardResults").innerHTML = '<div class="reward-stats"><span>Fomo buyer wallets <b>' + v.verifiedWallets + '</b></span><span>Unclaimed bonding fees <b>' + (Number(v.unclaimedQuoteLamports)/1e9).toFixed(5) + ' SOL</b></span><span>Paid receipts <b>' + paid.length + '</b></span></div><p>' + (v.indexing ? 'Scanning pool trades…' : v.lastIndexedAt ? 'Trades checked · ' + esc(new Date(v.lastIndexedAt).toLocaleString()) : 'Waiting for the first pool scan') + '</p>' + (v.epochs.length ? '<p>Latest cycle: ' + esc(v.epochs[0].status) + ' · <a target="_blank" rel="noopener" href="https://solscan.io/tx/' + esc(v.epochs[0].claimSignature) + '">Fee claim ↗</a></p>' : '<p>Fees distribute after Fomo buyers are indexed and the minimum reward amount accrues.</p>') + (paid.length ? '<div class="reward-receipts">' + paid.slice(0,5).map(x => '<a target="_blank" rel="noopener" href="https://solscan.io/tx/' + esc(x.signature) + '">' + esc(short(x.wallet)) + ' · ' + (Number(x.lamports)/1e9).toFixed(5) + ' SOL ↗</a>').join('') + '</div>' : '');
      const claims = v.epochs.filter(x => x.claimSignature).map(x => '<tr><td>Bonding fee claim</td><td>' + (x.claimedLamports == null ? "Pending" : (Number(x.claimedLamports)/1e9).toFixed(5) + " SOL") + '</td><td>' + esc(x.status) + '</td><td><a target="_blank" rel="noopener" href="https://solscan.io/tx/' + esc(x.claimSignature) + '">Receipt ↗</a></td></tr>');
      const payouts = v.payouts.filter(x=>x.status==="paid").slice(0,20).map(x => '<tr><td>' + (x.kind === "team-treasury" ? "Team treasury " : "Fomo trader ") + esc(short(x.wallet)) + '</td><td>' + (Number(x.lamports)/1e9).toFixed(5) + ' SOL</td><td>Paid</td><td><a target="_blank" rel="noopener" href="https://solscan.io/tx/' + esc(x.signature) + '">Receipt ↗</a></td></tr>');
      $("#rewardResults").insertAdjacentHTML("beforeend", '<div class="reward-ledger"><h3>On-chain receipt ledger</h3>' + (claims.length || payouts.length ? '<div class="table-wrap"><table><thead><tr><th>EVENT</th><th>AMOUNT</th><th>STATE</th><th>TX</th></tr></thead><tbody>' + [...claims,...payouts].join("") + '</tbody></table></div>' : '<p>No fee claims or payouts yet.</p>') + '</div>');
    } catch(e) { $("#rewardResults").textContent = e.message || "Reward status unavailable"; }
  };
  update();
  rewardTimer = setInterval(() => { if (!document.hidden) update(); }, 60_000);
}
async function feeProof(t) {
  const host = document.createElement("section");
  host.className = "panel proof-panel";
  host.innerHTML = '<div class="eyebrow">FEES / VERIFIED RECEIPTS</div><h2>Fee proof.</h2><p>Loading recorded claims and payouts…</p>';
  main.querySelector(".shell")?.appendChild(host);
  try {
    const data = await request("/api/tokens/" + encodeURIComponent(t.mint) + "/fees");
    if (!host.isConnected) return;
    const paid = data.events.filter(e=>e.kind==="trader-payout" && e.status==="paid").reduce((s,e)=>s+Number(e.amountLamports || 0),0);
    const treasury = data.events.filter(e=>e.kind==="team-treasury" && ["paid","complete"].includes(e.status)).reduce((s,e)=>s+Number(e.amountLamports || 0),0);
    const labels = {"creator-claim":"Creator claim","reward-fee-claim":"Bonding fee claim","trader-payout":"Fomo trader payout","team-treasury":"Team treasury"};
    host.innerHTML = '<div class="eyebrow">FEES / VERIFIED RECEIPTS</div><h2>Fee proof.</h2><p>' + (t.protocol==="DBC" ? (data.treasuryBps ? '20% of the controllable DBC bonding fee share is assigned to the team treasury. ' : 'This launch predates the team treasury split. ') + (t.rewardMode ? 'The remaining fee share routes to eligible Fomo traders.' : 'Creator fees can be claimed by the launch wallet.') : 'Stonk.fun handles creator fee forwarding under its own rules; Fomopad cannot verify a per-coin forwarding amount.') + '</p><div class="proof-stats"><span>Recorded trader payouts <b>' + (paid/1e9).toFixed(5) + ' SOL</b></span><span>Recorded treasury transfers <b>' + (treasury/1e9).toFixed(5) + ' SOL</b></span></div>' + (data.events.length ? '<div class="table-wrap"><table><thead><tr><th>EVENT</th><th>AMOUNT</th><th>STATE</th><th>RECEIPT</th></tr></thead><tbody>' + data.events.slice(0,80).map(e=>'<tr><td>' + esc(labels[e.kind] || e.kind) + (e.wallet ? ' · ' + esc(short(e.wallet)) : '') + '</td><td>' + (e.amountLamports == null ? 'See receipt' : (Number(e.amountLamports)/1e9).toFixed(5) + ' SOL') + '</td><td>' + esc(e.status) + '</td><td>' + (e.signature ? '<a target="_blank" rel="noopener" href="https://solscan.io/tx/' + esc(e.signature) + '">Solscan ↗</a>' : 'Pending') + '</td></tr>').join('') + '</tbody></table></div>' : '<p>No claims or payouts recorded yet.</p>') + '<small>Only Fomopad-recorded events appear here. Earlier creator claims may be missing; pending events are not counted as paid. Creator claim amounts must be checked on Solscan.</small>';
  } catch(e) { if (host.isConnected) host.innerHTML = '<div class="eyebrow">FEES / VERIFIED RECEIPTS</div><h2>Fee proof unavailable.</h2><p>' + esc(e.message) + '</p>'; }
}
function graduationTracker(t,curve) {
  if (t.protocol !== "DBC") return;
  const percent = curve ? Math.max(0,Math.min(100,Number(curve.progress)*100)) : null;
  const reserve = curve?.quoteReserveSol;
  const target = curve?.migrationThresholdSol || t.migrationThresholdSol;
  const section = document.createElement("section");
  section.className = "panel graduation-panel";
  section.innerHTML = '<div class="eyebrow">DBC / GRADUATION</div><h2>' + (curve?.migrated ? 'Graduated to DAMM v2.' : 'Bonding curve progress.') + '</h2>' + (percent == null ? '<p>Curve state is temporarily unavailable. Check the pool on Solscan.</p>' : '<div class="graduation-track"><span style="width:' + percent.toFixed(2) + '%"></span></div><p>' + percent.toFixed(1) + '% · ' + Number(reserve).toFixed(4) + ' / ' + Number(target).toFixed(4) + ' SOL quote reserve · ' + Math.max(0,Number(target)-Number(reserve)).toFixed(4) + ' SOL remaining</p>') + '<p>At the configured quote threshold, the DBC pool becomes eligible to migrate to Meteora DAMM v2. Migration status is read from the pool; this display does not guarantee a time.</p><a class="side-link" href="https://solscan.io/account/' + esc(t.pool) + '" target="_blank" rel="noopener">Verify pool ↗</a>';
  main.querySelector(".token-chart")?.insertAdjacentElement("afterend",section);
}
async function traderRewardsPage() {
  const owner = signedWallet || wallet;
  main.innerHTML = '<div class="shell"><div class="page-head"><div class="eyebrow">WALLET / FOMO REWARDS</div><h1>Your trader rewards.</h1><p class="lead">Verified Fomo buys and automatic DBC bonding fee payouts for your wallet.</p></div><section class="panel proof-panel" id="walletRewards">' + (owner ? 'Checking your verified trades…' : '<h2>Connect your wallet.</h2><p>Your wallet address is used to look up public trade proofs and payout receipts.</p><button class="primary" id="rewardsConnect">Connect wallet ↗</button>') + '</section></div>';
  if (!owner) { $("#rewardsConnect").onclick=()=>openWallet(); return; }
  try {
    const data = await request("/api/wallet/" + encodeURIComponent(owner) + "/rewards");
    const host = $("#walletRewards"); if (!host) return;
    const paid = data.allocations.filter(a=>a.status==="paid");
    const sum = paid.reduce((n,a)=>n+Number(a.lamports),0);
    host.innerHTML = '<div class="eyebrow">WALLET / ' + esc(short(owner)) + '</div><h2>' + (sum/1e9).toFixed(6) + ' SOL paid</h2><p>' + data.verifiedBuys.length + ' coin' + (data.verifiedBuys.length===1?'':'s') + ' with verified Fomo buys. Eligibility for “still hold” coins is checked again at each payout.</p>' + (data.verifiedBuys.length ? '<div class="reward-ledger"><h3>Verified buys</h3><div class="table-wrap"><table><thead><tr><th>COIN</th><th>REWARD RULE</th><th>PROOF</th></tr></thead><tbody>' + data.verifiedBuys.map(b=>'<tr><td><a href="#token/' + esc(b.mint) + '">$' + esc(b.symbol) + ' ↗</a></td><td>' + (b.rewardScope==="traders"?'Verified buy amount':'Verified buy + hold at payout') + '</td><td>Fomo buy indexed</td></tr>').join('') + '</tbody></table></div></div>' : '<p>No verified Fomo buys indexed for this wallet yet.</p>') + '<div class="reward-ledger"><h3>Payouts</h3>' + (data.allocations.length ? '<div class="table-wrap"><table><thead><tr><th>COIN</th><th>AMOUNT</th><th>STATE</th><th>TX</th></tr></thead><tbody>' + data.allocations.map(a=>'<tr><td><a href="#token/' + esc(a.mint) + '">' + esc(short(a.mint)) + ' ↗</a></td><td>' + (Number(a.lamports)/1e9).toFixed(6) + ' SOL</td><td>' + esc(a.status) + '</td><td>' + (a.signature ? '<a target="_blank" rel="noopener" href="https://solscan.io/tx/' + esc(a.signature) + '">Receipt ↗</a>' : 'Pending') + '</td></tr>').join('') + '</tbody></table></div>' : '<p>No payouts recorded yet.</p>') + '</div>';
  } catch(e) { if ($("#walletRewards")) $("#walletRewards").innerHTML='<h2>Rewards unavailable.</h2><p>' + esc(e.message) + '</p><button class="secondary" id="retryRewards">Retry ↗</button>'; $("#retryRewards")?.addEventListener("click",traderRewardsPage); }
}
let alertTimer = null;
async function alertsPage() {
  const owner = signedWallet || wallet;
  main.innerHTML = '<div class="shell"><div class="page-head"><div class="eyebrow">WALLET / ACTIVITY</div><h1>Launch alerts.</h1><p class="lead">Watchlist graduation, creator fees, launches, and trader reward receipts.</p></div><section class="panel proof-panel"><h2>In-app alerts</h2><p>Updates run while Fomopad is open. Browser notifications are optional and work only while this page is open.</p><button class="secondary" id="enableAlerts" type="button">Enable browser notifications ↗</button><div id="alertResults">Checking activity…</div></section></div>';
  $("#enableAlerts").onclick = async () => {
    if (!("Notification" in window)) return toast("Browser notifications are not supported here.");
    const state = await Notification.requestPermission();
    toast(state === "granted" ? "Notifications enabled while Fomopad is open." : "Notifications were not enabled.");
  };
  const refresh = async () => {
    if (!$("#alertResults")) return;
    try {
      const [board,activity,own] = await Promise.all([
        request("/api/tokens"),
        request("/api/activity"),
        owner ? request("/api/creator/" + encodeURIComponent(owner)) : Promise.resolve({tokens:[]})
      ]);
      const watched = new Set([...watch,...own.tokens.map(t=>t.mint)]);
      const alerts = [];
      for (const t of board.tokens) if (watched.has(t.mint)) {
        if (t.curve?.migrated) alerts.push({id:"graduated:"+t.mint,title:"Graduated · $"+t.symbol,detail:"DBC pool has migrated. Verify the pool receipt.",mint:t.mint});
        else if (t.curve?.progressPercent >= 90) alerts.push({id:"near:"+t.mint,title:"Near graduation · $"+t.symbol,detail:t.curve.progressPercent.toFixed(1)+"% of DBC quote reserve target",mint:t.mint});
      }
      for (const e of activity.events) if (watched.has(e.mint) && e.type==="launch") alerts.push({id:"launch:"+e.signature,title:"Launched · $"+e.symbol,detail:"Verified Solana launch receipt",mint:e.mint});
      for (const e of activity.events) if (e.type==="reward" && e.wallet===owner) alerts.push({id:"reward:"+e.signature,title:"Trader reward paid",detail:(Number(e.amountLamports)/1e9).toFixed(6)+" SOL · on-chain payout",mint:e.mint});
      for (const t of own.tokens.filter(t=>t.protocol==="DBC" && !t.rewardMode).slice(0,8)) {
        try { const fee=await request("/api/creator-fees/" + encodeURIComponent(t.mint)); if (fee.mode==="claim" && Number(fee.claimableQuoteLamports)>0) alerts.push({id:"fee:"+t.mint,title:"Claimable fees · $"+t.symbol,detail:(Number(fee.claimableQuoteLamports)/1e9).toFixed(6)+" SOL available",mint:t.mint}); } catch {}
      }
      const host=$("#alertResults"); if (!host) return;
      host.innerHTML = alerts.length ? alerts.map(a=>'<a class="alert-item" href="#token/' + esc(a.mint) + '"><b>' + esc(a.title) + '</b><span>' + esc(a.detail) + ' ↗</span></a>').join('') : '<p>No actionable activity for your watchlist or connected creator wallet yet.</p>';
      if ("Notification" in window && Notification.permission==="granted") {
        let seen=[]; try { seen=JSON.parse(localStorage.getItem("fomopad-alert-seen")||"[]"); } catch {}
        const known=new Set(seen);
        // First scan establishes the baseline and never floods a new visitor.
        if (localStorage.getItem("fomopad-alert-seen")) for (const a of alerts) if (!known.has(a.id)) new Notification(a.title,{body:a.detail,tag:a.id});
        localStorage.setItem("fomopad-alert-seen",JSON.stringify([...new Set([...seen,...alerts.map(a=>a.id)])].slice(-250)));
      }
    } catch(e) { if ($("#alertResults")) $("#alertResults").textContent="Activity temporarily unavailable: "+e.message; }
  };
  await refresh();
  alertTimer=setInterval(()=>{ if (!document.hidden) refresh(); },120_000);
}
const referenceCardsHTML = document.getElementById("bootDeck")?.innerHTML || "";
function about() {
  main.innerHTML = '<div class="shell"><div class="page-head"><div class="eyebrow">HOW IT WORKS / THE RULES</div><h1>From idea to <em style="color:#ad9dff;font-style:normal">fomo.</em></h1><p class="lead">An independent launch interface for Solana. Coins launch on Meteora DBC, trade on a bonding curve, then migrate to DAMM v2. Fomo is an external trading app.</p></div><div class="article-grid"><article class="panel article"><span class="number">01 / MINT</span><h3>An address with fomo built in.</h3><p>Fomopad prepares an Ed25519 mint signer in advance until its public address ends in <b>fomo</b>. The encrypted mint key stays on our backend and signs only the matching launch transaction; your wallet still reviews and approves that transaction.</p></article><article class="panel article"><span class="number">02 / LAUNCH</span><h3>A transaction you approve.</h3><p>The wallet signs a draft message, then a Meteora DBC config and pool transaction. The launch starts at 30–60 SOL market cap (30 SOL minimum), charges 1% on the curve, and targets an 88.5766 SOL quote reserve before DAMM v2 migration. Fomopad verifies the transaction and pool before listing it.</p></article><article class="panel article"><span class="number">03 / DISCOVER</span><h3>A board with receipts.</h3><p>Only successful launches are shown. Coin pages track the DBC reserve and migration progress and link to Solscan and a Jupiter quote. Once migrated, the DAMM v2 fee is 2% and the creator liquidity allocation is permanently locked. Fomo independently controls availability in its own app.</p></article><article class="panel article"><span class="number">04 / REWARDS</span><h3>Opt in for Fomo traders.</h3><p>Creators may assign the DBC bonding fee share to the rewards authority at launch. A Fomo co-signed buy receipt registers its receiving wallet; holders with a positive balance split claimed SOL fees by balance. Payouts have on-chain receipts. Other traders receive no reward. After migration, DAMM v2 fees go to the creator locked position. Fomo controls its own listings.</p></article></div><section class="panel reference-panel" aria-labelledby="reference-title"><div class="eyebrow">BACKGROUND / X POSTS</div><h2 id="reference-title">Reference posts</h2><p>Seven views of the same conversation, including a denial. Each preview links to its original post. Fomopad is independent.</p><div class="reference-cards">' + referenceCardsHTML + '</div></section><div class="strip"><strong>Ready to make your mark?</strong><p>Get a fomo mint and launch with your own wallet.</p><a href="#launch">Create coin ↗</a></div></div>';
  main.querySelector(".page-head .lead").textContent = "An independent Solana launch interface with two rails: Meteora DBC for configurable bonding and Fomo-only rewards, or Stonk.fun for its live Raydium LaunchLab curve.";
  const launchArticle = [...main.querySelectorAll(".article")].find(article => article.textContent.includes("02 / LAUNCH"));
  if (launchArticle) launchArticle.innerHTML = '<span class="number">02 / LAUNCH</span><h3>Choose the rail, then approve.</h3><p>Meteora DBC gives creators a 30–60 SOL starting-cap choice and optional Fomopad trader rewards. Stonk.fun uses its live SOL LaunchLab platform and curve and forwards standard creator fees to the launch wallet. Both rails use the reserved mint ending in fomo, and both require your wallet approval.</p>';
  const rewardsArticle = [...main.querySelectorAll(".article")].find(article => article.textContent.includes("04 / REWARDS"));
  if (rewardsArticle) rewardsArticle.innerHTML = '<span class="number">04 / REWARDS</span><h3>Choose the fee destination.</h3><p>On DBC, keep creator fees and claim accrued bonding fees in My launches, or select Fomo-only distribution. The traders route weighs every verified Fomo buy of this coin, even if a wallet later sells. The holders route requires a verified Fomo buy and a positive balance at payout, weighted by current balance. Other trade wallets do not qualify. Stonk.fun forwards its standard LaunchLab creator share automatically. After DBC migration, DAMM v2 fees remain with the creator locked position.</p>';
}
function docs() {
  main.innerHTML = '<div class="shell docs-shell"><div class="page-head docs-head"><div class="eyebrow">FOMOPAD DOCUMENTATION</div><h1>Launch with the full picture.</h1><p class="lead">Everything creators and traders need to understand before using Fomopad on Solana mainnet.</p><div class="docs-actions"><a class="primary" href="#launch">Launch a coin ↗</a><a class="secondary" href="#discover">View launches</a></div></div><div class="docs-layout"><nav class="docs-index" aria-label="Documentation sections"><strong>ON THIS PAGE</strong><a href="#docs-overview">Overview</a><a href="#docs-launch">Launch flow</a><a href="#docs-curve">Bonding curve</a><a href="#docs-fees">Claim fees</a><a href="#docs-rewards">Trader rewards</a><a href="#docs-market">Charts and listings</a><a href="#docs-safety">Security and limits</a></nav><article class="docs-content"><section id="docs-overview"><span class="docs-kicker">OVERVIEW</span><h2>What Fomopad does</h2><p>Fomopad is an independent Solana launch interface. It creates verified Meteora DBC launches with a mint address ending in <code>fomo</code>. Only launches with a confirmed on-chain receipt appear in Discover.</p><div class="docs-facts"><div><small>NETWORK</small><b>Solana mainnet</b></div><div><small>LAUNCH RAIL</small><b>Meteora DBC</b></div><div><small>MINT SUFFIX</small><b>…fomo</b></div><div><small>WALLET APPROVAL</small><b>Required</b></div></div><div class="docs-note"><b>Independent product</b><p>Fomopad is not affiliated with Fomo or Meteora. Fomo controls whether a token appears or trades inside its app.</p></div></section><section id="docs-launch"><span class="docs-kicker">LAUNCH FLOW</span><h2>From details to verified pool</h2><ol class="docs-steps"><li><b>Add the coin</b><p>Upload artwork, name the coin, choose a ticker, and add optional social links.</p></li><li><b>Pass identity checks</b><p>The ticker is checked against Fomopad reservations. Exact duplicate artwork is blocked. Similar names produce a warning.</p></li><li><b>Reserve a real fomo mint</b><p>A pre-generated Ed25519 mint ending in <code>fomo</code> is reserved to your signed-in wallet. Its encrypted signing key never enters the browser.</p></li><li><b>Review and sign</b><p>Your wallet reviews the mainnet transaction and pays Solana network and account rent. Fomopad adds no launch fee.</p></li><li><b>Verify the receipt</b><p>The API checks the transaction, DBC program, mint, config, pool, creator, and curve settings before the coin becomes visible.</p></li></ol></section><section id="docs-curve"><span class="docs-kicker">BONDING CURVE</span><h2>How pricing and graduation work</h2><div class="docs-specs"><div><span>Starting market cap</span><b>30 to 60 SOL</b></div><div><span>DBC trading fee</span><b>1%</b></div><div><span>Graduation target</span><b>88.5766 SOL quote reserve</b></div><div><span>After migration</span><b>Meteora DAMM v2</b></div><div><span>DAMM v2 pool fee</span><b>2%</b></div><div><span>Creator liquidity</span><b>Permanently locked</b></div></div><p>The starting market cap is a price estimate. It is not SOL deposited into the pool. Discover reads DBC reserve progress from the on-chain pool.</p></section><section id="docs-rewards"><span class="docs-kicker">FOMO TRADER REWARDS</span><h2>Optional automatic fee distribution</h2><p>A creator can opt in before launch. For an eligible coin, the DBC bonding fee share is assigned to the rewards authority. The selection cannot be changed after launch.</p><div class="docs-flow"><div><b>Qualifying buy</b><p>A Fomo co-signed on-chain buy identifies the receiving wallet.</p></div><div><b>Holder snapshot</b><p>Verified buyer wallets must still hold the coin when the payout snapshot is taken.</p></div><div><b>Automatic split</b><p>Claimed bonding fees are divided by current token balance and sent with on-chain receipts.</p></div></div><div class="docs-warning"><b>Current status</b><p>The system is enabled and its operating wallet is funded. No live end-to-end reward payout has been proven yet. DAMM v2 fees after graduation remain with the creator locked position.</p></div></section><section id="docs-market"><span class="docs-kicker">DISCOVERY AND CHARTS</span><h2>What market data means</h2><p>Token pages show the verified mint, pool, curve progress, Solscan links, and an interactive candlestick chart when indexed data is available. Market snapshots use DEX Screener. Candles use GeckoTerminal.</p><div class="docs-table"><div><b>Trending</b><span>Ranks by indexed 24-hour volume</span></div><div><b>Market cap</b><span>Ranks by available indexed market cap</span></div><div><b>Near graduation</b><span>Ranks by DBC quote-reserve progress</span></div><div><b>Rewards paid</b><span>Shows coins with confirmed reward payouts</span></div></div><p>Missing liquidity, market-cap, or candle data stays unavailable until third-party indexing catches up. Fomopad does not invent market activity.</p></section><section id="docs-safety"><span class="docs-kicker">SECURITY AND LIMITS</span><h2>Know what you approve</h2><ul class="docs-checks"><li>Wallet sign-in uses a message signature and does not spend SOL.</li><li>A launch requires a separate wallet-approved Solana transaction.</li><li>Fomopad never asks for a seed phrase or private key.</li><li>The public Solana RPC may rate-limit launches, charts, or reward scans during busy periods.</li><li>Metadata currently depends on the production API and database.</li><li>A reserved ticker remains claimed if a signed draft is abandoned.</li></ul><div class="docs-links"><a href="https://solscan.io" target="_blank" rel="noopener noreferrer">Solscan ↗</a><a href="https://docs.meteora.ag" target="_blank" rel="noopener noreferrer">Meteora docs ↗</a><a href="https://x.com/fomoxpad" target="_blank" rel="noopener noreferrer">@fomoxpad ↗</a></div></section></article></div></div>';
  const index = main.querySelector(".docs-index");
  index?.querySelector('a[href="#docs-launch"]')?.insertAdjacentHTML("beforebegin", '<a href="#docs-app">Mobile app</a>');
  $("#docs-launch")?.insertAdjacentHTML("beforebegin", '<section id="docs-app"><span class="docs-kicker">MOBILE APP</span><h2>Install Fomopad</h2><p>Open <a href="#install">Get the app</a> for home-screen installation on iPhone or Android. It uses the same live interface as the website. On iPhone, use Safari Share → Add to Home Screen; on Android, choose Install app from your browser menu. The app requires internet access for live launches, charts, and fees.</p><p>For mobile wallet signing, open Fomopad in Phantom or Solflare using the links on the app page. The home-screen app hands you to the wallet app when a wallet is not injected. Review and approve each launch or claim in your wallet.</p></section>');
  index?.querySelector('a[href="#docs-curve"]')?.insertAdjacentHTML("beforebegin", '<a href="#docs-rails">Launch rails</a>');
  const overview = $("#docs-overview");
  const overviewText = overview?.querySelector("p"); if (overviewText) overviewText.innerHTML = 'Fomopad is an independent Solana launch interface. It creates verified Meteora DBC or Stonk.fun launches with a mint address ending in <code>fomo</code>. Only launches with a confirmed on-chain receipt appear in Discover.';
  const railFact = overview?.querySelector(".docs-facts div:nth-child(2) b"); if (railFact) railFact.textContent = "DBC or Stonk.fun";
  $("#docs-launch")?.insertAdjacentHTML("afterend", '<section id="docs-rails"><span class="docs-kicker">LAUNCH RAILS</span><h2>Choose DBC or Stonk.fun</h2><div class="docs-table"><div><b>Meteora DBC</b><span>30–60 SOL starting cap, 1% curve fee, DAMM v2 migration</span></div><div><b>Stonk.fun</b><span>Live SOL Raydium LaunchLab curve, Token-2022 mint, standard creator-fee forwarding</span></div><div><b>Fomo traders only</b><span>Available on DBC through the Fomopad rewards authority</span></div><div><b>Same address rule</b><span>Both rails use the reserved mint ending in fomo</span></div></div><p>Stonk.fun terms are read from its public API when the transaction is prepared. The coin is listed on Fomopad only after the chain receipt verifies; Stonk.fun launches also wait for Stonk.fun adoption.</p></section>');
  const rewards = $("#docs-rewards");
  if (rewards) rewards.innerHTML = '<span class="docs-kicker">FEES & REWARDS</span><h2>Choose where DBC bonding fees go</h2><p>For new DBC launches, 20% of the non-protocol bonding fee share goes to the Fomopad team treasury at 6eJteDb9ag7gZviL1kgcQvyLjhJtMMt62Dh31W6nbWhx. The remaining 80% goes to the creator wallet or eligible Fomo traders, according to the signed launch draft. The split is fixed on-chain and does not apply to earlier launches or post-migration DAMM v2 fees.</p><div class="docs-table"><div><b>Creator fees</b><span>Accrue for the creator wallet. Sign in with that wallet, open Claim fees in the sidebar, then approve the Solana transaction. Network fees and token-account rent may apply.</span></div><div><b>Fomo traders of this coin</b><span>Fomo co-signed on-chain buyers of this coin share automatic payouts by cumulative verified buy amount; they may have sold since buying.</span></div><div><b>Fomo traders who still hold</b><span>Only Fomo co-signed buyers with a positive token balance at the payout snapshot qualify. Payouts are weighted by current balance.</span></div></div><p>Neither Fomo reward route pays unverified buyers. Each payout has an on-chain receipt. The team treasury allocation is separate from trader rewards. Stonk.fun forwards its standard LaunchLab creator share to the launch wallet automatically; Fomopad cannot enforce this treasury split or these DBC-only reward routes on Stonk.fun.</p><div class="docs-warning"><b>Current reward status</b><p>The operating authority is enabled and funded, but a live end-to-end reward payout has not yet been proven. Only DBC bonding fees are eligible; DAMM v2 fees after migration stay with the creator locked position.</p></div>';
  rewards?.insertAdjacentHTML("beforebegin", '<section id="docs-fees"><span class="docs-kicker">CREATOR FEES</span><h2>Claim DBC fees; check Stonk.fun status</h2><p>Open <a href="#fees">Claim fees</a> in the left menu to see launches tied to your wallet. Sign in with the wallet that launched the coin before approving any available claim. The coin page also links to its fee status.</p><div class="docs-table"><div><b>Meteora DBC</b><span>Creator-route bonding fees accrue per coin and can be claimed as SOL with wallet approval. Fomo trader reward routes distribute automatically and have no creator claim.</span></div><div><b>Current Stonk.fun LaunchLab</b><span>Stonk.fun forwards its standard creator share to the creator wallet automatically. There is no claim transaction to sign for these launches. Claim fees shows the venue status and its explanation.</span></div><div><b>Older Stonk.fun vaults</b><span>Only if Stonk.fun reports a claimable creator quote vault and the on-chain vault has WSOL will Fomopad offer a wallet-approved claim. SOL-pair launches from the same creator share that vault. The payout arrives as WSOL in the creator wallet’s token account.</span></div><div><b>After Stonk graduation</b><span>Any CPMM creator fees or LP Fee Key fees use separate rules. This LaunchLab vault action does not collect them.</span></div></div><p>Available claims require wallet approval, Solana network fees, and possibly token-account rent. Fomopad never signs with your creator wallet. A historical Stonk.fun wallet-approved claim has not yet been tested end to end.</p></section>');
  rewards?.insertAdjacentHTML("afterend", '<section id="docs-proof"><span class="docs-kicker">PROOF & ACTIVITY</span><h2>Check receipts and rewards</h2><p>Each coin page has a fee proof ledger with Fomopad-recorded creator claims, bonding fee claims, trader payouts, and team treasury transfers. Confirmed amounts link to Solscan. Creator claim amounts must be checked in the receipt, and claims made before this ledger was added may be absent.</p><p><a href="#rewards">My rewards</a> shows verified Fomo buys and payouts for the connected wallet. <a href="#alerts">Alerts</a> checks the watchlist and creator wallet for launches, graduation progress, claimable DBC fees, and paid trader rewards. Browser notifications require permission and the Fomopad page to remain open; there is no background push delivery.</p></section>');
}
function installPage() {
  main.innerHTML = '<div class="shell install-shell">'
    + '<div class="page-head"><div class="eyebrow">FOMOPAD / MOBILE</div><h1>Fomopad on your phone.</h1><p class="lead">Pick your device. Both options open the same live launchpad.</p></div>'
    + '<div class="install-grid">'
    + '<section class="panel install-card install-platform" aria-labelledby="androidTitle"><div class="install-platform-head"><span class="install-platform-label">ANDROID</span><img src="/icon-192.png" width="54" height="54" alt=""></div><h2 id="androidTitle">Download the APK</h2><p>Signed Android app for Android 7.0 and newer. It opens Fomopad under its own app icon.</p><a class="primary install-download" href="/download/android">Download APK ↗</a><p class="install-hint">Your phone may ask you to allow installation from your browser. Only download from fomopad.name.</p></section>'
    + '<section class="panel install-card install-platform" aria-labelledby="iphoneTitle"><div class="install-platform-head"><span class="install-platform-label">IPHONE</span><img src="/apple-touch-icon.png" width="54" height="54" alt=""></div><h2 id="iphoneTitle">Add to Home Screen</h2><p>Install Fomopad from Safari and open it from your iPhone home screen.</p><ol class="iphone-steps"><li>Open <b>fomopad.name</b> in Safari.</li><li>Tap <b>Share</b>, then <b>Add to Home Screen</b>.</li><li>Tap <b>Add</b> to finish.</li></ol><button class="secondary" type="button" id="copyIphoneLink">Copy iPhone link</button><span class="install-copy-status" id="copyIphoneStatus" role="status" aria-live="polite"></span><p class="install-hint">A signed iOS App Store build is not available yet. iPhones cannot install Android APKs.</p></section>'
    + '</div><section class="panel install-card install-wallet"><div><div class="eyebrow">WALLET ACCESS</div><h2>Launch from your wallet.</h2><p>Open Fomopad in Phantom or Solflare to connect, sign in, launch, and claim. Review each signature in your wallet.</p></div><div class="install-actions"><a class="secondary" id="openPhantom" href="#install">Open in Phantom ↗</a><a class="secondary" id="openSolflare" href="#install">Open in Solflare ↗</a></div></section></div>';
  $("#openPhantom").href = walletLink("phantom");
  $("#openSolflare").href = walletLink("solflare");
  $("#copyIphoneLink").onclick = async () => {
    const link = location.origin + "/#install";
    const status = $("#copyIphoneStatus");
    try { await navigator.clipboard.writeText(link); status.textContent = "Link copied"; }
    catch { status.textContent = "Copy this link: " + link; }
  };
}
function accountDataPage() {
 main.innerHTML = '<div class="shell"><div class="page-head"><div class="eyebrow">ACCOUNT / PRIVACY</div><h1>Your account data.</h1><p class="lead">Request deletion of private off-chain data associated with your signed-in Fomopad wallet.</p></div><section class="panel" style="padding:26px;max-width:720px"><p>Public blockchain transactions and published launch receipts cannot be erased. A request does not transfer funds, burn tokens, change fee ownership, or reverse a launch.</p><p id="deletionWallet"></p><button type="button" class="primary" id="requestDeletion">Request data deletion</button><p role="status" id="deletionStatus"></p><p><a href="/privacy">Privacy notice</a> · <a href="/delete-account">Deletion details</a> · <a href="https://x.com/fomoxpad" target="_blank" rel="noopener noreferrer">Contact Fomopad</a></p></section></div>';
 document.getElementById('deletionWallet').textContent = signedWallet ? 'Signed in: '+signedWallet : 'Sign in with the wallet for the account you want to delete.';
 document.getElementById('requestDeletion').onclick = async () => {
  if(!signedWallet || !authToken) { openWallet('signin'); return; }
  if(!confirm('Record an account data deletion request for '+signedWallet+'? The Fomopad operator will review it. Public blockchain records remain.')) return;
  const b=document.getElementById('requestDeletion'),status=document.getElementById('deletionStatus');b.disabled=true;
  try {const result=await request('/api/account/deletion-request',{method:'POST',headers:{authorization:'Bearer '+authToken}}); status.textContent=result.message; b.textContent='Request recorded';}
  catch(e){status.textContent=e.message; b.disabled=false;}
 };
}

function route() { closeChart(); clearInterval(rewardTimer); rewardTimer = null; clearInterval(alertTimer); alertTimer = null; const path = decodeURIComponent(location.hash.slice(1)) || "discover"; const rawSection = path.split("/")[0]; const section = rawSection.startsWith("docs-") ? "docs" : rawSection; document.querySelectorAll("[data-nav]").forEach(a=>a.classList.toggle("active",a.dataset.nav===(section === "token" ? "discover" : section))); if (section === "account-data") accountDataPage(); else if (section === "creator") creatorProfile(path.slice(8)); else if (section === "install") installPage(); else if (section === "launch") launch(); else if (section === "dashboard") dashboard(); else if (section === "fees") feesPage(); else if (section === "rewards") traderRewardsPage(); else if (section === "alerts") alertsPage(); else if (section === "about") about(); else if (section === "docs") docs(); else if (section === "token") tokenDetail(path.slice(6)); else discover(); window.scrollTo({top:0,behavior:"instant"}); if (rawSection.startsWith("docs-")) setTimeout(() => document.getElementById(rawSection)?.scrollIntoView({behavior:"smooth",block:"start"}), 0); }
async function creatorProfile(owner) {
  main.innerHTML = '<div class="shell"><div class="page-head"><div class="eyebrow">CREATOR / PROFILE</div><h1>Creator ' + esc(short(owner)) + '</h1><p class="lead">Verified launches from this Solana wallet.</p></div><div id="creatorCoins" class="coin-grid">Loading launches…</div></div>';
  try { const data = await request("/api/creator/" + encodeURIComponent(owner)); if (!$("#creatorCoins")) return; $("#creatorCoins").innerHTML = data.tokens.length ? coinCards(data.tokens) : '<p>No verified launches from this wallet.</p>'; }
  catch(e) { if ($("#creatorCoins")) $("#creatorCoins").textContent = "Profile unavailable: " + e.message; }
}
function focusSearch() { if (location.hash !== "#discover") location.hash = "#discover"; setTimeout(() => $("#search")?.focus(), 0); }
$("#globalSearch").onclick = focusSearch;
document.addEventListener("keydown", e => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); focusSearch(); } });
window.addEventListener("hashchange", route);
if (!location.hash && ["/install", "/launch", "/dashboard", "/fees", "/rewards", "/alerts", "/about", "/docs"].includes(location.pathname)) history.replaceState(null, "", location.pathname + "#" + location.pathname.slice(1));
route();
window.dispatchEvent(new Event("fomopad:ready"));
