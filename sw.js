/* RideLens 서비스 워커 — 하는 일이 딱 하나다: 안드로이드 '공유' 시트로 넘어온 파일 받기.
 *
 * 왜 필요한가: Web Share Target은 파일을 multipart POST로 보내는데, GitHub Pages 같은 정적
 * 호스팅은 POST를 받을 수 없다. 서비스 워커가 그 요청을 가로채 파일을 캐시에 넣고, 앱을 열어
 * 그 키를 넘겨준다. 서버 없이 스트라바·가민 앱 → RideLens로 파일이 바로 건너온다.
 *
 * 일부러 앱을 캐시하지 않는다. 오프라인 캐싱까지 얹으면 배포한 새 버전이 안 뜨는 사고가
 * 나기 쉽고(이 앱은 한 파일이라 통째로 바뀐다), 지금 얻으려는 건 공유 경로 하나뿐이다.
 * fetch 핸들러는 공유 POST가 아니면 아무 것도 하지 않고 그대로 통과시킨다.
 */
"use strict";

const SHARE_BOX = "ridelens-shared";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

/* ---------------- 주간 알림 ----------------
   서버는 **본문 없는 푸시**를 보낸다. "깨워라"만 말하고 무슨 말을 할지는 모른다.
   문장은 여기서 이 기기의 보관함(IndexedDB)을 직접 읽어 만든다 — "지난주 78km 타셨네요"가
   우리 서버를 거치지 않고 나온다. 서버가 저장하는 것은 브라우저가 준 푸시 주소뿐이다.

   보관함이 비어 있거나 못 읽으면 일반 문구로 대신한다(알림을 안 띄우면 브라우저가
   '조용한 푸시'로 보고 권한을 회수한다 — userVisibleOnly 계약이다). */
const DB = "ridelens";

function rides(){
  return new Promise((res) => {
    let done = false;
    const fin = (v) => { if (!done){ done = true; res(v); } };
    setTimeout(() => fin([]), 3000);                       // IndexedDB가 안 열리면 그냥 포기한다
    try {
      const rq = indexedDB.open(DB, 2);
      rq.onerror = () => fin([]);
      rq.onsuccess = () => {
        try {
          const db = rq.result;
          if (!db.objectStoreNames.contains("rides")) return fin([]);
          const g = db.transaction("rides").objectStore("rides").getAll();
          g.onsuccess = () => fin(g.result || []);
          g.onerror = () => fin([]);
        } catch (e) { fin([]); }
      };
      // 알림 때문에 스키마를 만들지는 않는다 — 앱을 한 번도 안 쓴 기기면 그냥 비운다
      rq.onupgradeneeded = () => { try { rq.transaction.abort(); } catch (e) {} fin([]); };
    } catch (e) { fin([]); }
  });
}

function weeklyMessage(list){
  const now = Date.now(), DAY = 86400000;
  const km = (a) => Math.round(a.reduce((s, r) => s + (((r.stats || {}).distance) || 0), 0) / 1000);
  const inRange = (from, to) => list.filter(r => r.date >= now - from * DAY && r.date < now - to * DAY);
  const thisWeek = inRange(7, 0), lastWeek = inRange(14, 7);
  if (!list.length)
    return { title: "이번 주 라이딩, 기록해 두셨나요?", body: "파일 하나만 넣으면 3초 뒤에 리포트가 나옵니다." };
  if (thisWeek.length)
    return { title: `이번 주 ${km(thisWeek)}km · ${thisWeek.length}회 타셨어요`,
             body: lastWeek.length ? `지난주는 ${km(lastWeek)}km였습니다. 주간 랭킹도 확인해 보세요.`
                                   : "주간 랭킹은 월요일에 0으로 초기화됩니다." };
  if (lastWeek.length)
    return { title: `지난주엔 ${km(lastWeek)}km 타셨네요`, body: "이번 주는 아직 기록이 없습니다. 주말에 한 번 나가시죠." };
  const last = list.slice().sort((a, b) => (b.date || 0) - (a.date || 0))[0];
  const days = Math.max(1, Math.round((now - (last.date || now)) / DAY));
  return { title: `마지막 라이딩이 ${days}일 전이었어요`, body: "가볍게 한 바퀴 어떠세요. 기록은 그대로 기다리고 있습니다." };
}

self.addEventListener("push", (e) => {
  e.waitUntil((async () => {
    let m;
    try { m = weeklyMessage(await rides()); }
    catch (err) { m = { title: "이번 주 라이딩, 기록해 두셨나요?", body: "파일 하나만 넣으면 3초 뒤에 리포트가 나옵니다." }; }
    await self.registration.showNotification("🚴 " + m.title, {
      body: m.body, tag: "ridelens-weekly", renotify: false,
      icon: "./logo-icon.png", badge: "./logo-icon.png", data: { open: "./app.html" }
    });
  })());
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const to = (e.notification.data && e.notification.data.open) || "./app.html";
  e.waitUntil((async () => {
    const url = new URL(to, self.registration.scope).href;
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    // 이미 열린 창이 있으면 그걸 앞으로 — 새 탭을 계속 쌓지 않는다
    for (const w of wins) if (w.url.startsWith(self.registration.scope) && "focus" in w) return w.focus();
    return self.clients.openWindow(url);
  })());
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // 공유로 들어온 POST만 처리한다 — 그 외의 요청은 건드리지 않는다(캐시도, 변형도 없음)
  if (e.request.method !== "POST" || !/\/share\/?$/.test(url.pathname)) return;

  e.respondWith((async () => {
    const to = new URL("app.html", url);
    try {
      const fd = await e.request.formData();
      // 매니페스트의 params.files.name 과 같은 이름. 이름이 달라 오는 클라이언트도 있어 전부 훑는다.
      let files = fd.getAll("file");
      if (!files.length) for (const v of fd.values()) if (v && typeof v === "object" && v.size) files.push(v);
      files = files.filter(f => f && f.size);
      if (!files.length) throw new Error("no files");

      const box = await caches.open(SHARE_BOX);
      const keys = [];
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const name = (f.name || "shared.fit").replace(/[^\w.\-가-힣]/g, "_");
        // 캐시 키는 실제로 존재하지 않아도 되는 경로다 — 앱이 이 키로 다시 꺼낸다
        const key = new URL(`__shared__/${Date.now()}-${i}`, url).href;
        await box.put(key, new Response(f, { headers: { "x-rl-name": encodeURIComponent(name) } }));
        keys.push(key);
      }
      to.searchParams.set("shared", keys.join("|"));
    } catch (err) {
      to.searchParams.set("shared", "err");
    }
    // 303이라야 브라우저가 POST를 GET으로 바꿔 앱을 연다
    return Response.redirect(to.href, 303);
  })());
});
