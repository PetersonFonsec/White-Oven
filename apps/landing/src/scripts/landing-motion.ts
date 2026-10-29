const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)");
const hero = document.querySelector<HTMLElement>(".hero");
const pizza = document.querySelector<HTMLElement>(".hero-pizza");
const stage = document.querySelector<HTMLElement>("[data-pointer-stage]");
const progress = document.querySelector<HTMLElement>(".reading-progress");
let pointerX = 0;
let pointerY = 0;
let frame = 0;

function render() {
  frame = 0;
  if (reducedMotion.matches) return;
  const travel = hero
    ? Math.max(
        0,
        Math.min(1, -hero.getBoundingClientRect().top / hero.offsetHeight),
      )
    : 0;
  if (pizza)
    pizza.style.transform = `translate3d(${pointerX * 18}px, ${pointerY * 14 + travel * 30}px, 0) rotate(${travel * 32 - 12 + pointerX * 5}deg)`;
  if (progress) {
    const distance = document.documentElement.scrollHeight - window.innerHeight;
    progress.style.transform = `scaleX(${distance > 0 ? window.scrollY / distance : 0})`;
  }
}
function schedule() {
  if (!frame) frame = window.requestAnimationFrame(render);
}
window.addEventListener("scroll", schedule, { passive: true });
window.addEventListener("resize", schedule, { passive: true });
stage?.addEventListener("pointermove", (event) => {
  if (!finePointer.matches || reducedMotion.matches) return;
  const bounds = stage.getBoundingClientRect();
  pointerX = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
  pointerY = ((event.clientY - bounds.top) / bounds.height) * 2 - 1;
  schedule();
});
stage?.addEventListener("pointerleave", () => {
  pointerX = 0;
  pointerY = 0;
  schedule();
});

const revealTargets = document.querySelectorAll<HTMLElement>(
  ".feature-card, .section-heading, .admin-window, .steps li, .pricing-card, .stores-inner > div, .faq-items details, .interest-grid > div",
);
const observer = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const element = entry.target as HTMLElement;
      if (!reducedMotion.matches) {
        const isFeature = element.classList.contains("feature-card");
        element.animate(
          [
            {
              opacity: 0.35,
              transform: isFeature ? "translateX(24px)" : "translateY(28px)",
            },
            { opacity: 1, transform: "none" },
          ],
          { duration: 750, easing: "cubic-bezier(.16,1,.3,1)" },
        );
      }
      observer.unobserve(element);
    }
  },
  { threshold: 0.12 },
);
revealTargets.forEach((element) => observer.observe(element));

document
  .querySelectorAll<HTMLElement>(
    ".hero-demo-link, .hero-actions .button:first-child",
  )
  .forEach((element) => {
    element.addEventListener("pointermove", (event) => {
      if (reducedMotion.matches || !finePointer.matches) return;
      const bounds = element.getBoundingClientRect();
      const x = (event.clientX - bounds.left - bounds.width / 2) * 0.12;
      const y = (event.clientY - bounds.top - bounds.height / 2) * 0.18;
      element.style.translate = `${x}px ${y}px`;
    });
    element.addEventListener("pointerleave", () =>
      element.style.removeProperty("translate"),
    );
  });

reducedMotion.addEventListener("change", () => {
  document.getAnimations().forEach((animation) => animation.finish());
  document
    .querySelectorAll<HTMLElement>(
      ".hero-demo-link, .hero-actions .button:first-child",
    )
    .forEach((element) => element.style.removeProperty("translate"));
  if (pizza) pizza.style.removeProperty("transform");
  if (progress) progress.style.removeProperty("transform");
  schedule();
});
schedule();
