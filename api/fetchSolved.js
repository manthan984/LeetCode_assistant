export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end(); // Preflight response for OPTIONS
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Only POST allowed' });
  }

  const { username } = req.body;

  if (!username) {
    return res.status(400).json({ error: 'Username is required' });
  }

  try {
    const recentSolved = await fetchRecentAcceptedSubmissions(username);

    let allSolvedSlugs = [];
    let source = 'recent';

    try {
      allSolvedSlugs = await fetchAllAcceptedSlugs(username);
      if (allSolvedSlugs.length) {
        source = 'full';
      }
    } catch (error) {
      console.error('Full history fetch failed, falling back to recent list:', error?.message);
      allSolvedSlugs = [];
    }

    if (!allSolvedSlugs.length) {
      try {
        allSolvedSlugs = await fetchAllAcceptedSlugsFromPublicApi(username);
        if (allSolvedSlugs.length) {
          source = 'full';
        }
      } catch (error) {
        console.error('Public submissions API full-history fetch failed:', error?.message);
        allSolvedSlugs = [];
      }
    }

    if (!allSolvedSlugs.length) {
      allSolvedSlugs = dedupeSlugs(recentSolved.map(item => item.titleSlug));
    }

    return res.status(200).json({
      source,
      recentSolved,
      allSolvedSlugs,
      counts: {
        recentSolved: recentSolved.length,
        allSolved: allSolvedSlugs.length
      }
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error", details: err.message });
  }
}

async function fetchRecentAcceptedSubmissions(username) {
  const query = {
    query: `
      query recentAccepted($username: String!) {
        recentAcSubmissionList(username: $username) {
          title
          titleSlug
          timestamp
        }
      }
    `,
    variables: { username }
  };

  const data = await graphqlRequest(query);
  const list = Array.isArray(data?.recentAcSubmissionList) ? data.recentAcSubmissionList : [];

  const dedupedBySlug = new Map();
  list.forEach(item => {
    if (!item?.titleSlug) return;

    const slug = String(item.titleSlug).trim();
    if (!slug) return;

    const timestamp = Number(item.timestamp || 0);
    const existing = dedupedBySlug.get(slug);

    if (!existing || timestamp > Number(existing.timestamp || 0)) {
      dedupedBySlug.set(slug, {
        title: item.title || slug,
        titleSlug: slug,
        timestamp
      });
    }
  });

  return Array.from(dedupedBySlug.values()).sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));
}

async function fetchAllAcceptedSlugs(username) {
  const accepted = new Set();
  const pageSize = 20;
  const maxPages = 500;

  let offset = 0;

  for (let page = 0; page < maxPages; page += 1) {
    const query = {
      query: `
        query submissionList($offset: Int!, $limit: Int!, $username: String!) {
          submissionList(offset: $offset, limit: $limit, username: $username) {
            hasNext
            submissions {
              titleSlug
              statusDisplay
            }
          }
        }
      `,
      variables: {
        offset,
        limit: pageSize,
        username
      }
    };

    const data = await graphqlRequest(query);
    const submissionList = data?.submissionList;
    const submissions = Array.isArray(submissionList?.submissions) ? submissionList.submissions : [];

    submissions.forEach(submission => {
      if (!submission?.titleSlug) return;
      if (submission.statusDisplay !== 'Accepted') return;
      accepted.add(String(submission.titleSlug).trim());
    });

    if (!submissionList?.hasNext || submissions.length === 0) {
      break;
    }

    offset += pageSize;
  }

  return Array.from(accepted).filter(Boolean);
}

async function fetchAllAcceptedSlugsFromPublicApi(username) {
  const accepted = new Set();
  const pageSize = 20;
  const maxPages = 500;

  let offset = 0;

  for (let page = 0; page < maxPages; page += 1) {
    const url = `https://leetcode.com/api/submissions/${encodeURIComponent(username)}/?offset=${offset}&limit=${pageSize}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`Public submissions API failed (${response.status})`);
    }

    const data = await response.json();
    const submissions = Array.isArray(data?.submissions_dump) ? data.submissions_dump : [];

    submissions.forEach(submission => {
      if (!submission) return;

      const slug = typeof submission.title_slug === 'string'
        ? submission.title_slug.trim()
        : '';

      if (!slug) return;

      const status = submission.status_display || submission.statusDisplay;
      if (status !== 'Accepted') return;

      accepted.add(slug);
    });

    const hasNext = Boolean(data?.has_next);
    if (!hasNext || submissions.length === 0) {
      break;
    }

    offset += pageSize;
  }

  return Array.from(accepted);
}

async function graphqlRequest(payload) {
  const response = await fetch('https://leetcode.com/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const json = await response.json();

  if (!response.ok) {
    throw new Error(`LeetCode GraphQL request failed (${response.status})`);
  }

  if (json?.errors?.length) {
    throw new Error(json.errors[0]?.message || 'LeetCode GraphQL returned errors');
  }

  return json?.data || {};
}

function dedupeSlugs(slugs) {
  return Array.from(new Set((Array.isArray(slugs) ? slugs : []).map(slug => String(slug || '').trim()).filter(Boolean)));
}
