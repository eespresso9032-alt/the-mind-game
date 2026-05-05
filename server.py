import asyncio
import json
import os
import random
import itertools
import time
import mimetypes
from pathlib import Path
from aiohttp import web
import aiohttp

# ── Config ───────────────────────────────────────────────
PORT         = int(os.environ.get('PORT', 3000))
GAME_KEY     = os.environ.get('GAME_KEY', ''.join(random.choices('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', k=6)))
MAX_ROOMS    = int(os.environ.get('MAX_ROOMS', 10))
ROOM_TTL_SEC = 7200   # 2時間で未使用ルームを削除
RATE_LIMIT   = 5      # 同一IPから60秒以内の接続上限

PUBLIC_DIR = Path(__file__).parent / 'public'

# ── Rate limiting ────────────────────────────────────────
_ip_ts: dict[str, list[float]] = {}

def check_rate(ip: str) -> bool:
    now = time.time()
    ts = [t for t in _ip_ts.get(ip, []) if now - t < 60]
    _ip_ts[ip] = ts
    if len(ts) >= RATE_LIMIT:
        return False
    _ip_ts[ip].append(now)
    return True

# ── Game state ───────────────────────────────────────────
rooms:   dict = {}
clients: dict = {}
_id_gen = itertools.count(1)

LIFE_BONUS = {2: {3,5,7}, 3: {4,6,9}, 4: {5,7,10}}
STAR_BONUS = {2: {2,5},   3: {3,6},   4: {4,8}}

def gen_code():
    chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    while True:
        code = ''.join(random.choices(chars, k=4))
        if code not in rooms:
            return code

def deal_cards(room):
    deck = random.sample(range(1, 101), 100)
    idx = 0
    for p in room['players']:
        p['cards'] = sorted(deck[idx:idx + 3])
        p['bananas'] = 1
        idx += 3
    room['playedCards'] = []
    room['last_active'] = time.time()

def all_played(room):
    return all(len(p['cards']) == 0 for p in room['players'])

def pub(room):
    return {
        'code':        room['code'],
        'host':        room['host'],
        'round':       room.get('round', 1),
        'lives':       room['lives'],
        'stars':       room['stars'],
        'playedCards': room['playedCards'],
        'status':      room['status'],
        'players': [{'id': p['id'], 'name': p['name'], 'cardCount': len(p['cards']), 'bananas': p.get('bananas', 0)}
                    for p in room['players']],
    }

def touch(room):
    room['last_active'] = time.time()

async def emit(ws, t, **kw):
    await ws.send_json({'type': t, **kw})

async def bcast(room, t, **kw):
    msg = {'type': t, 'room': pub(room), **kw}
    for p in room['players']:
        w = clients.get(p['id'], {}).get('ws')
        if w and not w.closed:
            await w.send_json(msg)

async def bcast_with_cards(room, t, **kw):
    msg = {'type': t, 'room': pub(room), **kw}
    for p in room['players']:
        w = clients.get(p['id'], {}).get('ws')
        if w and not w.closed:
            await w.send_json(msg)
            await w.send_json({'type': 'yourCards', 'cards': p['cards']})

async def advance_level(room):
    room['round'] = room.get('round', 1) + 1
    deal_cards(room)
    await bcast_with_cards(room, 'roundClear', round=room['round'])

# ── Room expiry ───────────────────────────────────────────
async def cleanup_loop():
    while True:
        await asyncio.sleep(300)
        now = time.time()
        expired = [code for code, r in list(rooms.items())
                   if now - r.get('last_active', now) > ROOM_TTL_SEC]
        for code in expired:
            room = rooms.pop(code, None)
            if room:
                for p in room['players']:
                    w = clients.get(p['id'], {}).get('ws')
                    if w and not w.closed:
                        await w.send_json({'type': 'error', 'message': 'ルームが時間切れで削除されました'})
        if expired:
            print(f'[cleanup] expired: {expired}')

# ── WebSocket handler ─────────────────────────────────────
async def ws_handler(request):
    ip = request.remote or '?'
    if not check_rate(ip):
        raise web.HTTPTooManyRequests(text='接続が多すぎます。しばらく待ってください')

    ws = web.WebSocketResponse(heartbeat=30)
    await ws.prepare(request)

    cid = f"c{next(_id_gen)}"
    clients[cid] = {'ws': ws, 'roomCode': None, 'name': None}
    await emit(ws, 'connected', id=cid)

    try:
        async for msg in ws:
            if msg.type != aiohttp.WSMsgType.TEXT:
                break
            d = json.loads(msg.data)
            t = d.get('type', '')
            me = clients.get(cid, {})
            room = rooms.get(me.get('roomCode'))
            if room:
                touch(room)

            if t in ('createRoom', 'joinRoom'):
                if d.get('gameKey', '').upper() != GAME_KEY:
                    await emit(ws, 'error', message='ゲームキーが違います')
                    continue

            if t == 'createRoom':
                if len(rooms) >= MAX_ROOMS:
                    await emit(ws, 'error', message=f'ルーム数が上限（{MAX_ROOMS}）に達しています')
                    continue
                code = gen_code()
                rooms[code] = {
                    'code': code, 'host': cid,
                    'players': [{'id': cid, 'name': d['name'], 'cards': []}],
                    'level': 1, 'maxLevel': 12,
                    'lives': 0, 'stars': 0,
                    'playedCards': [], 'status': 'waiting',
                    'last_active': time.time(),
                }
                me['roomCode'] = code
                me['name'] = d['name']
                await emit(ws, 'roomCreated', code=code, room=pub(rooms[code]))

            elif t == 'joinRoom':
                code = d['code'].upper()
                name = d['name']
                r = rooms.get(code)
                if not r:
                    await emit(ws, 'error', message='ルームが見つかりません')
                elif r['status'] != 'waiting':
                    await emit(ws, 'error', message='ゲームはすでに始まっています')
                elif len(r['players']) >= 4:
                    await emit(ws, 'error', message='ルームが満員です（最大4人）')
                elif any(p['name'] == name for p in r['players']):
                    await emit(ws, 'error', message='同じ名前のプレイヤーがいます')
                else:
                    r['players'].append({'id': cid, 'name': name, 'cards': []})
                    me['roomCode'] = code
                    me['name'] = name
                    await emit(ws, 'joinedRoom', room=pub(r))
                    for p in r['players']:
                        if p['id'] != cid:
                            ow = clients.get(p['id'], {}).get('ws')
                            if ow and not ow.closed:
                                await ow.send_json({'type': 'playerJoined', 'room': pub(r), 'name': name})

            elif t == 'startGame':
                if not room or room['host'] != cid: continue
                if len(room['players']) < 2:
                    await emit(ws, 'error', message='2人以上でないと開始できません')
                    continue
                room['lives']  = len(room['players'])
                room['stars']  = 1
                room['level']  = 1
                room['status'] = 'playing'
                deal_cards(room)
                await bcast_with_cards(room, 'gameStarted')

            elif t == 'playCard':
                if not room or room['status'] != 'playing': continue
                card   = d['card']
                player = next((p for p in room['players'] if p['id'] == cid), None)
                if not player or card not in player['cards']: continue

                lower = [c for p in room['players'] for c in p['cards'] if c < card]
                player['cards'] = [c for c in player['cards'] if c != card]
                room['playedCards'].append(card)

                if lower:
                    room['lives'] -= 1
                    discarded = []
                    for p in room['players']:
                        lows = [c for c in p['cards'] if c < card]
                        for c in lows:
                            discarded.append({'playerId': p['id'], 'playerName': p['name'], 'card': c})
                            room['playedCards'].append(c)
                        p['cards'] = [c for c in p['cards'] if c >= card]
                    if room['lives'] <= 0:
                        room['status'] = 'lost'
                        for p in room['players']:
                            pw = clients.get(p['id'], {}).get('ws')
                            if pw and not pw.closed:
                                await pw.send_json({'type': 'gameLost', 'room': pub(room),
                                                    'wrongCard': card, 'playerName': player['name'],
                                                    'discarded': discarded})
                                await pw.send_json({'type': 'yourCards', 'cards': p['cards']})
                        continue
                    await bcast_with_cards(room, 'mistake',
                                           wrongCard=card, playerName=player['name'], discarded=discarded)
                else:
                    await bcast_with_cards(room, 'cardPlayed', card=card, playerName=player['name'])

                if all_played(room):
                    await advance_level(room)

            elif t == 'useStar':
                if not room or room['status'] != 'playing' or room['stars'] <= 0: continue
                room['stars'] -= 1
                discarded = []
                for p in room['players']:
                    if p['cards']:
                        lowest = p['cards'].pop(0)
                        room['playedCards'].append(lowest)
                        discarded.append({'playerId': p['id'], 'playerName': p['name'], 'card': lowest})
                await bcast_with_cards(room, 'starUsed', discarded=discarded, usedBy=me['name'])
                if all_played(room):
                    await advance_level(room)

            elif t == 'useBanana':
                if not room or room['status'] != 'playing': continue
                player = next((p for p in room['players'] if p['id'] == cid), None)
                if not player or player.get('bananas', 0) <= 0: continue
                target = next((p for p in room['players'] if p['id'] == d.get('targetId')), None)
                if not target or target['id'] == cid: continue
                if not player['cards'] or not target['cards']: continue
                pc = random.choice(player['cards'])
                tc = random.choice(target['cards'])
                player['cards'] = sorted([c for c in player['cards'] if c != pc] + [tc])
                target['cards'] = sorted([c for c in target['cards'] if c != tc] + [pc])
                player['bananas'] -= 1
                await bcast(room, 'bananaUsed', fromName=player['name'], toName=target['name'])
                pw = clients.get(player['id'], {}).get('ws')
                if pw and not pw.closed:
                    await pw.send_json({'type': 'yourCards', 'cards': player['cards']})
                tw = clients.get(target['id'], {}).get('ws')
                if tw and not tw.closed:
                    await tw.send_json({'type': 'yourCards', 'cards': target['cards']})

            elif t == 'restartGame':
                if not room or room['host'] != cid or room['status'] not in ('won', 'lost'): continue
                room['lives']  = len(room['players'])
                room['stars']  = 1
                room['level']  = 1
                room['status'] = 'playing'
                deal_cards(room)
                await bcast_with_cards(room, 'gameStarted')

            elif t == 'returnToLobby':
                if not room or room['host'] != cid: continue
                room['status'] = 'waiting'
                for p in room['players']:
                    p['cards'] = []
                room['playedCards'] = []
                await bcast(room, 'backToLobby')

    except Exception:
        pass
    finally:
        me   = clients.pop(cid, {})
        code = me.get('roomCode')
        name = me.get('name')
        if code and code in rooms:
            r = rooms[code]
            r['players'] = [p for p in r['players'] if p['id'] != cid]
            if not r['players']:
                del rooms[code]
            else:
                if r['host'] == cid:
                    r['host'] = r['players'][0]['id']
                for p in r['players']:
                    pw = clients.get(p['id'], {}).get('ws')
                    if pw and not pw.closed:
                        await pw.send_json({'type': 'playerLeft', 'room': pub(r), 'name': name})

    return ws

# ── Static file handler ───────────────────────────────────
async def static_handler(request):
    path = request.match_info.get('path', '') or 'index.html'
    if not path or path == '/':
        path = 'index.html'
    file_path = PUBLIC_DIR / path
    if not file_path.exists() or not file_path.is_file():
        file_path = PUBLIC_DIR / 'index.html'
    ctype, _ = mimetypes.guess_type(str(file_path))
    return web.Response(body=file_path.read_bytes(), content_type=ctype or 'application/octet-stream')

# ── App ───────────────────────────────────────────────────
app = web.Application()
app.router.add_get('/ws', ws_handler)
app.router.add_get('/', static_handler)
app.router.add_get('/{path:.*}', static_handler)

async def on_startup(app):
    asyncio.create_task(cleanup_loop())

app.on_startup.append(on_startup)

if __name__ == '__main__':
    print(f'\n🧠 The Mind サーバー起動！')
    print(f'   http://localhost:{PORT}')
    print(f'\n🔑 ゲームキー: {GAME_KEY}')
    print(f'   (変更: GAME_KEY=yourkey python3 server.py)\n')
    web.run_app(app, host='0.0.0.0', port=PORT, print=lambda _: None)
