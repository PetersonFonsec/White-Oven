// Scroll, cursor and entrance motion for the landing. Every effect lives in a
// gsap.matchMedia context so "reduce motion" (also toggled at runtime) reverts
// it and leaves the static, fully readable page.
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { SplitText } from "gsap/SplitText";
import Lenis from "lenis";

gsap.registerPlugin(ScrollTrigger, SplitText);

const root = document.documentElement;
const $ = <T extends Element = HTMLElement>(
  selector: string,
  scope: ParentNode = document,
) => scope.querySelector<T>(selector);
const $$ = <T extends Element = HTMLElement>(
  selector: string,
  scope: ParentNode = document,
) => Array.from(scope.querySelectorAll<T>(selector));

const MOTION = "(prefers-reduced-motion: no-preference)";
const FINE_POINTER = "(hover: hover) and (pointer: fine)";
const headerOffset = () => ($(".site-header")?.offsetHeight ?? 0) + 24;

let lenis: Lenis | undefined;

// Header: compact state after leaving the top of the page.
const header = $(".site-header");
const updateHeader = () =>
  header?.toggleAttribute("data-scrolled", window.scrollY > 24);
updateHeader();
window.addEventListener("scroll", updateHeader, { passive: true });

// Brand identities: buttons switch the showcase; scroll drives them when pinned.
const identities = $("[data-identities]");
const identityButtons = $$<HTMLButtonElement>("[data-identity]");
let activeIdentity = 0;
const showIdentity = (index: number) => {
  const button = identityButtons[index];
  if (!identities || !button || index === activeIdentity) return;
  activeIdentity = index;
  for (const prop of ["--id-brand", "--id-on-brand", "--id-page", "--id-ink"]) {
    identities.style.setProperty(prop, button.style.getPropertyValue(prop));
  }
  identityButtons.forEach((other) =>
    other.setAttribute("aria-pressed", String(other === button)),
  );
  const set = (selector: string, value = "") => {
    const target = $(selector, identities);
    if (target) target.textContent = value;
  };
  set("[data-identity-name]", button.dataset.name);
  set("[data-identity-tagline]", button.dataset.tagline);
  set("[data-identity-logo]", button.dataset.logo);
  set("[data-identity-big]", button.dataset.name);
  identities.dataset.active = String(index);
  if (!matchMedia(MOTION).matches) return;
  gsap.fromTo(
    $$(".phone-content > *", identities),
    { y: 14, opacity: 0 },
    {
      y: 0,
      opacity: 1,
      duration: 0.5,
      stagger: 0.04,
      ease: "power3.out",
      overwrite: true,
    },
  );
  gsap.fromTo(
    "[data-identity-big]",
    { yPercent: 30, opacity: 0 },
    {
      yPercent: 0,
      opacity: 1,
      duration: 0.7,
      ease: "expo.out",
      overwrite: true,
    },
  );
};
let identityTrigger: ScrollTrigger | undefined;
identityButtons.forEach((button, index) => {
  button.disabled = false;
  button.addEventListener("click", () => {
    if (identityTrigger) {
      const { start, end } = identityTrigger;
      const target =
        start + ((index + 0.5) / identityButtons.length) * (end - start);
      if (lenis) {
        lenis.resize();
        lenis.scrollTo(window.scrollY, { immediate: true });
        lenis.scrollTo(target, { duration: 1.2 });
      } else window.scrollTo({ top: target });
    }
    showIdentity(index);
  });
});

// Anchor links scroll smoothly through Lenis but keep the hash and focus behaviour.
document.addEventListener("click", (event) => {
  const link = (event.target as Element).closest<HTMLAnchorElement>(
    'a[href^="#"]',
  );
  if (!lenis || !link || event.defaultPrevented) return;
  const hash = link.getAttribute("href")!;
  const target =
    hash.length > 1 ? document.getElementById(hash.slice(1)) : null;
  if (!target) return;
  event.preventDefault();
  history.pushState(null, "", hash);
  // A native scroll right before the click (e.g. scrollIntoView) may not have
  // reached Lenis yet, and pin spacers change the page height: resync first
  // and target an absolute position.
  lenis.resize();
  lenis.scrollTo(window.scrollY, { immediate: true });
  lenis.scrollTo(
    target.getBoundingClientRect().top + window.scrollY - headerOffset(),
    {
      duration: 1.2,
      onComplete: () => {
        if (!target.matches("a, button, input, select, textarea, [tabindex]")) {
          target.setAttribute("tabindex", "-1");
        }
        target.focus({ preventScroll: true });
      },
    },
  );
});

// ScrollTrigger restores the computed scroll-behavior inline after a refresh, which
// would freeze "smooth" on the root; the stylesheet must stay in charge of it.
const releaseScrollBehavior = () =>
  root.style.removeProperty("scroll-behavior");
ScrollTrigger.addEventListener("refresh", releaseScrollBehavior);

const media = gsap.matchMedia();

media.add(MOTION, () => {
  // Smooth scroll synced with ScrollTrigger on the GSAP ticker.
  lenis = new Lenis({ lerp: 0.09, wheelMultiplier: 0.9 });
  lenis.on("scroll", ScrollTrigger.update);
  const resizeLenis = () => lenis?.resize();
  ScrollTrigger.addEventListener("refresh", resizeLenis);
  const raf = (time: number) => lenis?.raf(time * 1000);
  gsap.ticker.add(raf);
  gsap.ticker.lagSmoothing(0);

  // Intro: counter "heating the oven", then the curtain opens onto the hero.
  const intro = gsap.timeline({ defaults: { ease: "expo.out" } });
  const preloader = $("[data-preloader]");
  if (root.classList.contains("js-intro") && preloader) {
    const count = { value: 0 };
    const label = $("[data-preloader-count]", preloader)!;
    intro
      .to(count, {
        value: 250,
        duration: 1,
        ease: "power2.inOut",
        onUpdate: () => (label.textContent = String(Math.round(count.value))),
      })
      .to(
        ".preloader-glow",
        { scale: 2.4, opacity: 1, duration: 1, ease: "power2.in" },
        0,
      )
      .to(preloader, {
        clipPath: "inset(0 0 100% 0)",
        duration: 0.9,
        ease: "expo.inOut",
      })
      .add(() => root.classList.remove("js-intro"));
  } else {
    root.classList.remove("js-intro");
  }
  intro
    .from(
      ".hero-title .line > span",
      { yPercent: 115, duration: 1.3, stagger: 0.09 },
      "-=0.45",
    )
    .from(
      "[data-hero-fade]",
      { y: 24, opacity: 0, duration: 1, stagger: 0.08 },
      "-=1",
    )
    .from(
      "[data-hero-pizza]",
      { scale: 0.6, rotate: -90, opacity: 0, duration: 1.6 },
      "<-0.4",
    )
    .from(
      "[data-hero-stage] .ingredient",
      {
        scale: 0,
        opacity: 0,
        duration: 1.2,
        stagger: 0.05,
        ease: "back.out(2)",
      },
      "<0.3",
    )
    .from(
      ".site-header .header-inner",
      { y: -40, opacity: 0, duration: 1 },
      "<",
    )
    .from(".scroll-cue", { opacity: 0, duration: 1 }, "<0.4");

  // Hero leaves: pizza spins and sinks, copy drifts up.
  const hero = $("[data-hero]");
  if (hero) {
    const scrub = {
      trigger: hero,
      start: "top top",
      end: "bottom top",
      scrub: true,
    };
    gsap.to("[data-hero-pizza] img", {
      rotate: 120,
      ease: "none",
      scrollTrigger: scrub,
    });
    gsap.to("[data-hero-pizza]", {
      yPercent: 18,
      scale: 0.9,
      ease: "none",
      scrollTrigger: scrub,
    });
    gsap.to(".hero-copy", {
      yPercent: -18,
      opacity: 0.2,
      ease: "none",
      scrollTrigger: scrub,
    });
    $$("[data-hero-stage] .ingredient").forEach((item) =>
      gsap.to(item, {
        y: () => -160 * Number(item.dataset.depth),
        rotate: 40 * Number(item.dataset.depth),
        ease: "none",
        scrollTrigger: scrub,
      }),
    );
  }

  // Marquee: an endless loop whose speed and direction follow scroll velocity.
  const loops = $$("[data-marquee-track]").map((track) => {
    const direction = Number(track.dataset.marqueeTrack);
    gsap.set(track, { xPercent: direction > 0 ? 0 : -50 });
    return {
      direction,
      tween: gsap.to(track, {
        xPercent: direction > 0 ? -50 : 0,
        duration: 28,
        ease: "none",
        repeat: -1,
      }),
    };
  });
  const marquee = $("[data-marquee]");
  if (marquee) {
    let settle: gsap.core.Tween | undefined;
    ScrollTrigger.create({
      trigger: marquee,
      start: "top bottom",
      end: "bottom top",
      onUpdate: (self) => {
        const speed = gsap.utils.clamp(
          1,
          6,
          Math.abs(self.getVelocity()) / 250,
        );
        loops.forEach(({ tween }) => tween.timeScale(speed * self.direction));
        settle?.kill();
        settle = gsap.to(
          loops.map(({ tween }) => tween),
          {
            timeScale: self.direction,
            duration: 0.8,
            ease: "power2.out",
            delay: 0.05,
          },
        );
      },
    });
    gsap.fromTo(
      ".marquee-row",
      { rotate: -3 },
      {
        rotate: 2,
        ease: "none",
        scrollTrigger: {
          trigger: marquee,
          start: "top bottom",
          end: "bottom top",
          scrub: true,
        },
      },
    );
  }

  // Section headings rise line by line from a mask.
  $$(".section-heading h2, .identities-copy h2, .stores h2").forEach(
    (heading) => {
      SplitText.create(heading, {
        type: "lines",
        mask: "lines",
        autoSplit: true,
        onSplit: (self) =>
          gsap.from(self.lines, {
            yPercent: 110,
            duration: 1.1,
            stagger: 0.08,
            ease: "expo.out",
            scrollTrigger: { trigger: heading, start: "top 88%" },
          }),
      });
    },
  );

  // Generic entrances for content blocks.
  ScrollTrigger.batch(
    ".section-description, .section-heading .eyebrow, .builder-card, .admin-grid > div:first-child > :not(.section-heading), .pricing-card, .pricing-notes, .lead-form, .notice, .faq-items details, .store-badges, .identities-description, .identity-list li",
    {
      start: "top 90%",
      once: true,
      onEnter: (batch) =>
        gsap.from(batch, {
          y: 40,
          opacity: 0,
          duration: 1,
          stagger: 0.08,
          ease: "expo.out",
        }),
    },
  );

  // Dashboard assembles: bars grow and figures count up.
  const admin = $("[data-admin]");
  if (admin) {
    const tl = gsap.timeline({
      scrollTrigger: { trigger: admin, start: "top 75%", once: true },
    });
    tl.from(admin, {
      y: 80,
      rotateX: 18,
      opacity: 0,
      duration: 1.3,
      ease: "expo.out",
    })
      .from(
        $$(".bar-chart span", admin),
        {
          scaleY: 0,
          transformOrigin: "bottom",
          duration: 1,
          stagger: 0.08,
          ease: "expo.out",
        },
        "-=0.8",
      )
      .from(
        $$(".admin-bottom p", admin),
        { x: -20, opacity: 0, stagger: 0.08 },
        "<",
      );
    $$("[data-count]", admin).forEach((element) => {
      const end = Number(element.dataset.count);
      const prefix = element.dataset.prefix ?? "";
      const value = { current: 0 };
      tl.to(
        value,
        {
          current: end,
          duration: 1.6,
          ease: "power3.out",
          onUpdate: () => {
            element.textContent =
              prefix + Math.round(value.current).toLocaleString("pt-BR");
          },
        },
        0.2,
      );
    });
  }

  // Steps: the line burns from left to right and lights each step as it passes.
  const steps = $("[data-steps]");
  if (steps) {
    const items = $$("[data-step]", steps);
    gsap.fromTo(
      "[data-steps-line]",
      { scaleX: 0 },
      {
        scaleX: 1,
        ease: "none",
        scrollTrigger: {
          trigger: steps,
          start: "top 75%",
          end: "bottom 55%",
          scrub: 0.6,
          onUpdate: (self) =>
            items.forEach((item, i) =>
              item.toggleAttribute(
                "data-lit",
                self.progress >= i / items.length + 0.05,
              ),
            ),
        },
      },
    );
    gsap.from(items, {
      y: 60,
      opacity: 0,
      stagger: 0.12,
      duration: 1,
      ease: "expo.out",
      scrollTrigger: { trigger: steps, start: "top 80%" },
    });
  }

  // Store tiles drift at different speeds.
  $$<HTMLElement>(".store-tile[data-speed]").forEach((tile) =>
    gsap.fromTo(
      tile,
      { y: 80 * Number(tile.dataset.speed) },
      {
        y: -80 * Number(tile.dataset.speed),
        ease: "none",
        scrollTrigger: {
          trigger: ".stores",
          start: "top bottom",
          end: "bottom top",
          scrub: true,
        },
      },
    ),
  );

  // Footer wordmark rises letter by letter.
  gsap.from("[data-wordmark] span", {
    yPercent: 100,
    duration: 1.2,
    stagger: 0.04,
    ease: "expo.out",
    scrollTrigger: { trigger: "[data-wordmark]", start: "top 95%" },
  });

  return () => {
    gsap.ticker.remove(raf);
    ScrollTrigger.removeEventListener("refresh", resizeLenis);
    lenis?.destroy();
    lenis = undefined;
    root.classList.remove("js-intro");
    releaseScrollBehavior();
  };
});

// Brand showcase: pinned and scroll driven on wider screens, auto-cycling on small ones.
media.add(`${MOTION} and (min-width: 768px)`, () => {
  if (!identities || identityButtons.length === 0) return;
  identityTrigger = ScrollTrigger.create({
    trigger: identities,
    start: "top top",
    end: () => `+=${window.innerHeight * identityButtons.length * 0.8}`,
    pin: ".identities-pin",
    onUpdate: (self) =>
      showIdentity(
        Math.min(
          identityButtons.length - 1,
          Math.floor(self.progress * identityButtons.length),
        ),
      ),
  });
  gsap.fromTo(
    ".identities-stage .phone-preview",
    { rotate: 8, y: 60 },
    {
      rotate: -4,
      y: -20,
      ease: "none",
      scrollTrigger: {
        trigger: identities,
        start: "top bottom",
        end: () => identityTrigger!.end,
        scrub: true,
      },
    },
  );
  return () => {
    identityTrigger = undefined;
  };
});
media.add(`${MOTION} and (max-width: 767px)`, () => {
  if (!identities) return;
  let timer: number | undefined;
  const trigger = ScrollTrigger.create({
    trigger: identities,
    start: "top 70%",
    end: "bottom 30%",
    onToggle: (self) => {
      window.clearInterval(timer);
      if (self.isActive) {
        timer = window.setInterval(
          () => showIdentity((activeIdentity + 1) % identityButtons.length),
          2200,
        );
      }
    },
  });
  return () => {
    window.clearInterval(timer);
    trigger.kill();
  };
});

// Features: vertical scroll becomes a horizontal journey on desktop.
media.add(`${MOTION} and (min-width: 1024px)`, () => {
  const section = $("[data-features]");
  const viewport = $("[data-features-viewport]");
  const track = $("[data-features-track]");
  if (!section || !viewport || !track) return;
  section.dataset.pinned = "true";
  const distance = () => track.scrollWidth - viewport.clientWidth;
  gsap.to(track, {
    x: () => -distance(),
    ease: "none",
    scrollTrigger: {
      trigger: section,
      start: "top top",
      end: () => `+=${distance()}`,
      pin: true,
      scrub: 0.8,
      invalidateOnRefresh: true,
      onUpdate: (self) =>
        gsap.set("[data-features-progress]", { scaleX: self.progress }),
    },
  });
  return () => {
    delete section.dataset.pinned;
  };
});

// Pointer effects only where a precise pointer exists.
media.add(`${MOTION} and ${FINE_POINTER}`, () => {
  root.classList.add("has-cursor");
  const cursor = document.createElement("div");
  cursor.className = "cursor";
  cursor.setAttribute("aria-hidden", "true");
  cursor.innerHTML =
    '<span class="cursor-dot"></span><span class="cursor-ring"><span class="cursor-label"></span></span>';
  document.body.append(cursor);
  const dot = $(".cursor-dot", cursor)!;
  const ring = $(".cursor-ring", cursor)!;
  const label = $(".cursor-label", cursor)!;
  const dotX = gsap.quickTo(dot, "x", { duration: 0.1, ease: "power3" });
  const dotY = gsap.quickTo(dot, "y", { duration: 0.1, ease: "power3" });
  const ringX = gsap.quickTo(ring, "x", { duration: 0.45, ease: "power3" });
  const ringY = gsap.quickTo(ring, "y", { duration: 0.45, ease: "power3" });

  const hero = $("[data-hero]");
  const pizza = $("[data-hero-pizza]");
  const ingredients = $$("[data-hero-stage] .ingredient");
  const tiltX =
    pizza && gsap.quickTo(pizza, "rotationY", { duration: 1, ease: "power3" });
  const tiltY =
    pizza && gsap.quickTo(pizza, "rotationX", { duration: 1, ease: "power3" });
  const drift = ingredients.map((item) => ({
    depth: Number(item.dataset.depth),
    x: gsap.quickTo(item, "x", { duration: 1.2, ease: "power3" }),
    y: gsap.quickTo(item, "yPercent", { duration: 1.2, ease: "power3" }),
  }));

  const onMove = (event: PointerEvent) => {
    const { clientX: x, clientY: y } = event;
    dotX(x);
    dotY(y);
    ringX(x);
    ringY(y);
    cursor.dataset.visible = "true";
    if (hero && pizza && tiltX && tiltY) {
      const rect = hero.getBoundingClientRect();
      if (rect.bottom > 0) {
        const nx = x / window.innerWidth - 0.5;
        const ny = (y - rect.top) / rect.height - 0.5;
        hero.style.setProperty("--glow-x", `${x}px`);
        hero.style.setProperty("--glow-y", `${y - rect.top}px`);
        tiltX(nx * 22);
        tiltY(-ny * 22);
        drift.forEach(({ depth, x: moveX, y: moveY }) => {
          moveX(-nx * 60 * depth);
          moveY(-ny * 40 * depth);
        });
      }
    }
  };
  const onOver = (event: PointerEvent) => {
    const target = (event.target as Element).closest<HTMLElement>(
      "a, button, summary, select, label, [data-cursor]",
    );
    cursor.dataset.state = target ? "hover" : "";
    const text = target?.dataset.cursor ?? "";
    label.textContent = text;
    cursor.dataset.label = text ? "true" : "false";
    if ((event.target as Element).closest("input, textarea, select"))
      cursor.dataset.state = "text";
  };
  const onLeave = () => (cursor.dataset.visible = "false");
  const onDown = () => (cursor.dataset.pressed = "true");
  const onUp = () => (cursor.dataset.pressed = "false");
  window.addEventListener("pointermove", onMove);
  document.addEventListener("pointerover", onOver);
  document.documentElement.addEventListener("pointerleave", onLeave);
  window.addEventListener("pointerdown", onDown);
  window.addEventListener("pointerup", onUp);

  // Magnetic buttons pull toward the pointer and spring back.
  const magnets = $$(".button, .identity-list button, .scroll-cue").map(
    (element) => {
      const x = gsap.quickTo(element, "x", {
        duration: 0.6,
        ease: "elastic.out(1, 0.4)",
      });
      const y = gsap.quickTo(element, "y", {
        duration: 0.6,
        ease: "elastic.out(1, 0.4)",
      });
      const move = (event: PointerEvent) => {
        const rect = element.getBoundingClientRect();
        x((event.clientX - rect.left - rect.width / 2) * 0.3);
        y((event.clientY - rect.top - rect.height / 2) * 0.4);
      };
      const leave = () => {
        x(0);
        y(0);
      };
      element.addEventListener("pointermove", move);
      element.addEventListener("pointerleave", leave);
      return () => {
        element.removeEventListener("pointermove", move);
        element.removeEventListener("pointerleave", leave);
        gsap.set(element, { clearProps: "transform" });
      };
    },
  );

  // Cards light up where the pointer passes.
  const glowCards = $$(".feature-card, .pricing-card, .builder-card");
  const onGlow = (event: PointerEvent) => {
    const card = event.currentTarget as HTMLElement;
    const rect = card.getBoundingClientRect();
    card.style.setProperty("--gx", `${event.clientX - rect.left}px`);
    card.style.setProperty("--gy", `${event.clientY - rect.top}px`);
  };
  glowCards.forEach((card) => card.addEventListener("pointermove", onGlow));

  // The builder pizza leans toward the pointer.
  const builderArt = $("[data-builder] .pizza-art");
  const builderVisual = $("[data-builder] .builder-visual");
  const leanX =
    builderArt &&
    gsap.quickTo(builderArt, "rotationY", { duration: 0.8, ease: "power3" });
  const leanY =
    builderArt &&
    gsap.quickTo(builderArt, "rotationX", { duration: 0.8, ease: "power3" });
  const onLean = (event: PointerEvent) => {
    if (!builderVisual || !leanX || !leanY) return;
    const rect = builderVisual.getBoundingClientRect();
    leanX(((event.clientX - rect.left) / rect.width - 0.5) * 18);
    leanY(-((event.clientY - rect.top) / rect.height - 0.5) * 18);
  };
  const onLeanEnd = () => {
    leanX?.(0);
    leanY?.(0);
  };
  builderVisual?.addEventListener("pointermove", onLean);
  builderVisual?.addEventListener("pointerleave", onLeanEnd);

  return () => {
    root.classList.remove("has-cursor");
    cursor.remove();
    window.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerover", onOver);
    document.documentElement.removeEventListener("pointerleave", onLeave);
    window.removeEventListener("pointerdown", onDown);
    window.removeEventListener("pointerup", onUp);
    magnets.forEach((dispose) => dispose());
    glowCards.forEach((card) =>
      card.removeEventListener("pointermove", onGlow),
    );
    builderVisual?.removeEventListener("pointermove", onLean);
    builderVisual?.removeEventListener("pointerleave", onLeanEnd);
  };
});

// Images and fonts change heights; recalculate pinned distances once loaded.
window.addEventListener("load", () => ScrollTrigger.refresh());
