/* ═══════════════════════════════════════════════
   UNDER 45 CEOs — scripts.js
   ══════════════════════════════════════════════ */

document.addEventListener('DOMContentLoaded', () => {
  // Navbar scroll
  const navbar = document.getElementById('navbar');
  window.addEventListener('scroll', () => navbar.classList.toggle('scrolled', window.scrollY > 60), { passive: true });
  navbar?.classList.toggle('scrolled', window.scrollY > 60);

  // Mobile menu
  const hamburger = document.getElementById('hamburger');
  const mobileMenu = document.getElementById('mobileMenu');
  if (hamburger && mobileMenu) {
    hamburger.addEventListener('click', () => {
      hamburger.classList.toggle('open');
      mobileMenu.classList.toggle('open');
    });
    mobileMenu.querySelectorAll('a').forEach(link => link.addEventListener('click', () => {
      hamburger.classList.remove('open');
      mobileMenu.classList.remove('open');
    }));
  }

  // ───── Theme toggle (dark default / light "milk" mode) ─────
  const root = document.documentElement;
  const toggles = document.querySelectorAll('.theme-toggle');

  function applyTheme(theme) {
    root.setAttribute('data-theme', theme);
    try { localStorage.setItem('u45_theme', theme); } catch (e) {}
    toggles.forEach(t => {
      t.setAttribute('aria-checked', theme === 'light' ? 'true' : 'false');
      const icon = t.querySelector('.theme-toggle__knob i');
      if (icon) icon.className = theme === 'light' ? 'fas fa-sun' : 'fas fa-moon';
    });
  }

  toggles.forEach(toggle => {
    // Initialize icon on load
    const currentTheme = root.getAttribute('data-theme') || 'dark';
    const icon = toggle.querySelector('.theme-toggle__knob i');
    if (icon) icon.className = currentTheme === 'light' ? 'fas fa-sun' : 'fas fa-moon';

    toggle.addEventListener('click', () => {
      const current = root.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
      applyTheme(current === 'light' ? 'dark' : 'light');
    });
  });

  // Sticky Banner - appears after scrolling past hero
  const stickyBanner = document.getElementById('stickyBanner');
  const closeBanner = document.getElementById('closeBanner');

  if (stickyBanner) {
    window.addEventListener('scroll', () => {
      const heroHeight = document.querySelector('.hero')?.offsetHeight || 500;
      if (window.scrollY > heroHeight - 100) {
        stickyBanner.classList.add('visible');
      } else {
        stickyBanner.classList.remove('visible');
      }
    });

    if (closeBanner) {
      closeBanner.addEventListener('click', () => {
        stickyBanner.style.display = 'none';
      });
    }
  }

  // Countdown Timer - for Discount Tickets ending Sept 15, 2026
  function updateCountdown() {
    const discountDate = new Date('September 15, 2026 00:00:00').getTime();
    const now = new Date().getTime();
    const distance = discountDate - now;

    const daysEl = document.getElementById('timerDays');
    const hoursEl = document.getElementById('timerHours');
    const minsEl = document.getElementById('timerMinutes');
    const secsEl = document.getElementById('timerSeconds');
    const stickyBanner = document.getElementById('stickyBanner');
    if (!daysEl || !hoursEl || !minsEl || !secsEl) return;

    if (distance < 0) {
      if (stickyBanner) stickyBanner.style.display = 'none';
      return;
    }

    const days = Math.floor(distance / (1000 * 60 * 60 * 24));
    const hours = Math.floor((distance % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((distance % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((distance % (1000 * 60)) / 1000);

    daysEl.textContent = String(days).padStart(2, '0');
    hoursEl.textContent = String(hours).padStart(2, '0');
    minsEl.textContent = String(minutes).padStart(2, '0');
    secsEl.textContent = String(seconds).padStart(2, '0');
  }

  updateCountdown();
  setInterval(updateCountdown, 1000);

  // Scroll reveal
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.12 });
  document.querySelectorAll('.reveal-up, .reveal-right').forEach(el => observer.observe(el));

  // Observe sponsorship teaser separately
  const sponsorTeaser = document.querySelector('.sponsor-teaser');
  if (sponsorTeaser) {
    const teaserObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
          teaserObserver.unobserve(entry.target);
        }
      });
    }, { threshold: 0.15 });
    teaserObserver.observe(sponsorTeaser);
  }

  // Impact counter animation - preserves ₦ and Million text
  const impactCards = document.querySelectorAll('.impact-card__num');
  const impactObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const el = entry.target;
        const originalText = el.getAttribute('data-original') || el.textContent;
        if (!el.getAttribute('data-original')) {
          el.setAttribute('data-original', originalText);
        }

        let numericMatch = originalText.match(/(\d+(?:,\d+)?)/);
        let suffix = '';
        let prefix = '';

        if (originalText.includes('₦')) prefix = '₦';
        if (originalText.includes('Million')) suffix = ' Million+';
        else if (originalText.includes('+')) suffix = '+';

        let target = 0;
        if (numericMatch) {
          target = parseInt(numericMatch[1].replace(/,/g, ''), 10);
        } else {
          target = parseInt(originalText.replace(/[^0-9]/g, ''), 10);
        }

        let start = 0;
        const duration = 1500;
        const increment = target / (duration / 16);
        const counter = setInterval(() => {
          start = Math.min(start + increment, target);
          let displayValue = Math.floor(start);

          if (target >= 1000) {
            displayValue = displayValue.toLocaleString();
          }

          if (prefix === '₦' && suffix === ' Million+') {
            el.textContent = `₦${displayValue} Million+`;
          } else if (prefix === '₦') {
            el.textContent = `₦${displayValue}${suffix}`;
          } else {
            el.textContent = `${displayValue}${suffix}`;
          }

          if (start >= target) clearInterval(counter);
        }, 16);
        impactObserver.unobserve(el);
      }
    });
  }, { threshold: 0.5 });
  impactCards.forEach(card => impactObserver.observe(card));

  // Ticker duplication
  const ticker = document.getElementById('ticker');
  if (ticker) ticker.innerHTML += ticker.innerHTML;

  // Smooth animation for sponsor logos
  const sponsorTrack = document.querySelector('.sponsors-track');
  if (sponsorTrack) {
    sponsorTrack.addEventListener('mouseenter', () => {
      sponsorTrack.style.animationPlayState = 'paused';
    });
    sponsorTrack.addEventListener('mouseleave', () => {
      sponsorTrack.style.animationPlayState = 'running';
    });
  }
});