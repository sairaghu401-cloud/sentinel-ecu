// Presentation only: no imports from the simulation, no workers and no API calls.
const legacyViews = new Set(['overview', 'traffic', 'validation', 'guide']);
if ((location.pathname === '/' || location.pathname === '/index.html') && legacyViews.has(location.hash.slice(1))) {
  location.replace(`/simulator/${location.hash}`);
} else {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const lowPower = navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4;
  const motion = () => !reduced.matches && !lowPower;
  const syncMotion = () => document.documentElement.classList.toggle('motion-enabled', motion());
  syncMotion();
  reduced.addEventListener('change', syncMotion);
  document.addEventListener('visibilitychange', () => document.documentElement.classList.toggle('page-hidden', document.hidden));

  const board = document.querySelector('.story-board');
  const steps = [...document.querySelectorAll('.story-step')];
  const labels = ['Traffic enters CAN A', 'Evidence reaches the analyst', 'Protection has separate authority'];
  function setStage(index) {
    if (!board) return;
    board.dataset.stage = String(index + 1);
    board.querySelector('[data-stage-label]').textContent = labels[index];
    steps.forEach((step, i) => step.classList.toggle('is-active', i === index));
  }
  // Observers respond to section boundaries; no per-frame scroll handler or forced scrolling.
  if ('IntersectionObserver' in window) {
    let storyObserver;
    const observeStory = () => {
      storyObserver?.disconnect();
      // Vertical percentage root margins are relative to width; use viewport pixels.
      const inset = Math.round(innerHeight * .45);
      storyObserver = new IntersectionObserver(entries => {
        for (const entry of entries) if (entry.isIntersecting) setStage(steps.indexOf(entry.target));
      }, { rootMargin: `-${inset}px 0px -${inset}px 0px`, threshold: 0 });
      steps.forEach(step => storyObserver.observe(step));
    };
    observeStory();
    window.addEventListener('resize', observeStory, { passive: true });
    if (board) {
      const visibility = new IntersectionObserver(([entry]) => board.classList.toggle('in-view', entry.isIntersecting));
      visibility.observe(board);
    }
    const reveals = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) {
        if (motion()) entry.target.classList.add('reveal-arrived');
        reveals.unobserve(entry.target);
      }
    }, { threshold: .12 });
    document.querySelectorAll('[data-reveal]').forEach(node => reveals.observe(node));
  }

  // The guide explains existing controls. It cannot start a run or change a session.
  const preview = document.querySelector('.guide-preview');
  const choices = [...document.querySelectorAll('[data-guide-step]')];
  const descriptions = [
    'Choose the attack family and the signal you want to investigate. The laboratory offers six controlled scenarios.',
    'Set the strength, then the duration. Low flooding offers 100 extra frames/s; maximum offers 15,000. Strength and detected risk are different.',
    'Read gateway decisions, Pi payload findings and vehicle safety separately. A filtered frame does not automatically mean a shutdown.'
  ];
  choices.forEach((choice, index) => choice.addEventListener('click', () => {
    choices.forEach(item => item.setAttribute('aria-pressed', String(item === choice)));
    preview.dataset.guide = String(index + 1);
    preview.querySelector('[data-guide-description]').textContent = descriptions[index];
  }));
}
