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
