"use client";

import { useEffect, useState } from "react";

import type { Locale } from "@/lib/domain/types";
import { dictionaries } from "@/lib/i18n/dictionaries";

interface Review {
  rating: number;
  satisfaction?: string | null;
  liked?: string | null;
  publishedName: string;
  createdAt?: string | null;
}

export function PublicReviews({ locale }: { locale: Locale }) {
  const ar = locale === "ar";
  const [reviews, setReviews] = useState<Review[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/reviews/public", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error("reviews unavailable");
        setReviews(Array.isArray(payload.data) ? payload.data as Review[] : []);
      })
      .catch(() => { if (!controller.signal.aborted) setError(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);

  if (loading) return <div className="marketing-empty"><span className="loading-orbit" /><p>{ar ? "جارٍ تحميل التقييمات المنشورة…" : "Loading published reviews…"}</p></div>;
  if (error) return <div className="marketing-empty"><p>{ar ? "تعذر تحميل التقييمات حاليًا." : "Reviews are temporarily unavailable."}</p></div>;
  if (reviews.length === 0) return <div className="marketing-empty"><span className="empty-state-mark">◇</span><h2>{ar ? "الثقة لا تُختلق." : "Trust is never fabricated."}</h2><p>{dictionaries[locale].reviews.empty}</p></div>;

  return <div className="published-reviews">{reviews.map((review, index) => <article className="platform-card published-review" key={`${review.createdAt || index}-${index}`}><div className="review-stars" aria-label={`${review.rating} / 5`}>{Array.from({ length: 5 }, (_, star) => <span key={star} className={star < review.rating ? "is-filled" : ""}>★</span>)}</div>{review.liked && <p>{review.liked}</p>}{review.satisfaction && <p className="review-satisfaction">{review.satisfaction}</p>}<span className="review-author">{review.publishedName}</span></article>)}</div>;
}
