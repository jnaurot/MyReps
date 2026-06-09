BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'state_legislators'
      AND column_name = 'jurisdiction'
  ) THEN
    UPDATE state_legislators
    SET state = CASE
      WHEN jurisdiction ~ '^[A-Za-z]{2}$' THEN UPPER(jurisdiction)
      WHEN UPPER(COALESCE(state, '')) IN (
        'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD',
        'MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC',
        'SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC','PR','GU','VI','AS','MP'
      ) THEN UPPER(state)
      WHEN LOWER(COALESCE(state, '')) = 'district of columbia' THEN 'DC'
      WHEN LOWER(COALESCE(state, '')) = 'puerto rico' THEN 'PR'
      WHEN LOWER(COALESCE(state, '')) = 'guam' THEN 'GU'
      WHEN LOWER(COALESCE(state, '')) IN ('u.s. virgin islands', 'virgin islands') THEN 'VI'
      WHEN LOWER(COALESCE(state, '')) = 'american samoa' THEN 'AS'
      WHEN LOWER(COALESCE(state, '')) = 'northern mariana islands' THEN 'MP'
      WHEN LOWER(COALESCE(state, '')) = 'alabama' THEN 'AL'
      WHEN LOWER(COALESCE(state, '')) = 'alaska' THEN 'AK'
      WHEN LOWER(COALESCE(state, '')) = 'arizona' THEN 'AZ'
      WHEN LOWER(COALESCE(state, '')) = 'arkansas' THEN 'AR'
      WHEN LOWER(COALESCE(state, '')) = 'california' THEN 'CA'
      WHEN LOWER(COALESCE(state, '')) = 'colorado' THEN 'CO'
      WHEN LOWER(COALESCE(state, '')) = 'connecticut' THEN 'CT'
      WHEN LOWER(COALESCE(state, '')) = 'delaware' THEN 'DE'
      WHEN LOWER(COALESCE(state, '')) = 'florida' THEN 'FL'
      WHEN LOWER(COALESCE(state, '')) = 'georgia' THEN 'GA'
      WHEN LOWER(COALESCE(state, '')) = 'hawaii' THEN 'HI'
      WHEN LOWER(COALESCE(state, '')) = 'idaho' THEN 'ID'
      WHEN LOWER(COALESCE(state, '')) = 'illinois' THEN 'IL'
      WHEN LOWER(COALESCE(state, '')) = 'indiana' THEN 'IN'
      WHEN LOWER(COALESCE(state, '')) = 'iowa' THEN 'IA'
      WHEN LOWER(COALESCE(state, '')) = 'kansas' THEN 'KS'
      WHEN LOWER(COALESCE(state, '')) = 'kentucky' THEN 'KY'
      WHEN LOWER(COALESCE(state, '')) = 'louisiana' THEN 'LA'
      WHEN LOWER(COALESCE(state, '')) = 'maine' THEN 'ME'
      WHEN LOWER(COALESCE(state, '')) = 'maryland' THEN 'MD'
      WHEN LOWER(COALESCE(state, '')) = 'massachusetts' THEN 'MA'
      WHEN LOWER(COALESCE(state, '')) = 'michigan' THEN 'MI'
      WHEN LOWER(COALESCE(state, '')) = 'minnesota' THEN 'MN'
      WHEN LOWER(COALESCE(state, '')) = 'mississippi' THEN 'MS'
      WHEN LOWER(COALESCE(state, '')) = 'missouri' THEN 'MO'
      WHEN LOWER(COALESCE(state, '')) = 'montana' THEN 'MT'
      WHEN LOWER(COALESCE(state, '')) = 'nebraska' THEN 'NE'
      WHEN LOWER(COALESCE(state, '')) = 'nevada' THEN 'NV'
      WHEN LOWER(COALESCE(state, '')) = 'new hampshire' THEN 'NH'
      WHEN LOWER(COALESCE(state, '')) = 'new jersey' THEN 'NJ'
      WHEN LOWER(COALESCE(state, '')) = 'new mexico' THEN 'NM'
      WHEN LOWER(COALESCE(state, '')) = 'new york' THEN 'NY'
      WHEN LOWER(COALESCE(state, '')) = 'north carolina' THEN 'NC'
      WHEN LOWER(COALESCE(state, '')) = 'north dakota' THEN 'ND'
      WHEN LOWER(COALESCE(state, '')) = 'ohio' THEN 'OH'
      WHEN LOWER(COALESCE(state, '')) = 'oklahoma' THEN 'OK'
      WHEN LOWER(COALESCE(state, '')) = 'oregon' THEN 'OR'
      WHEN LOWER(COALESCE(state, '')) = 'pennsylvania' THEN 'PA'
      WHEN LOWER(COALESCE(state, '')) = 'rhode island' THEN 'RI'
      WHEN LOWER(COALESCE(state, '')) = 'south carolina' THEN 'SC'
      WHEN LOWER(COALESCE(state, '')) = 'south dakota' THEN 'SD'
      WHEN LOWER(COALESCE(state, '')) = 'tennessee' THEN 'TN'
      WHEN LOWER(COALESCE(state, '')) = 'texas' THEN 'TX'
      WHEN LOWER(COALESCE(state, '')) = 'utah' THEN 'UT'
      WHEN LOWER(COALESCE(state, '')) = 'vermont' THEN 'VT'
      WHEN LOWER(COALESCE(state, '')) = 'virginia' THEN 'VA'
      WHEN LOWER(COALESCE(state, '')) = 'washington' THEN 'WA'
      WHEN LOWER(COALESCE(state, '')) = 'west virginia' THEN 'WV'
      WHEN LOWER(COALESCE(state, '')) = 'wisconsin' THEN 'WI'
      WHEN LOWER(COALESCE(state, '')) = 'wyoming' THEN 'WY'
      ELSE NULL
    END;

    ALTER TABLE state_legislators
      ALTER COLUMN state TYPE varchar(2) USING UPPER(state)::varchar(2),
      ALTER COLUMN state SET NOT NULL;

    DROP INDEX IF EXISTS idx_state_legislators_jurisdiction_district;
    CREATE INDEX IF NOT EXISTS idx_state_legislators_state_district
      ON state_legislators(state, district);

    ALTER TABLE state_legislators DROP COLUMN jurisdiction;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'state_bills'
      AND column_name = 'jurisdiction'
  ) THEN
    ALTER TABLE state_bills RENAME COLUMN jurisdiction TO state;
  END IF;

  ALTER TABLE state_bills
    ALTER COLUMN state TYPE varchar(2) USING UPPER(state)::varchar(2),
    ALTER COLUMN state SET NOT NULL;

  DROP INDEX IF EXISTS idx_state_bills_jurisdiction;
  CREATE INDEX IF NOT EXISTS idx_state_bills_state ON state_bills(state);
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'state_vote_records'
      AND column_name = 'jurisdiction'
  ) THEN
    ALTER TABLE state_vote_records RENAME COLUMN jurisdiction TO state;
  END IF;

  ALTER TABLE state_vote_records
    ALTER COLUMN state TYPE varchar(2) USING UPPER(state)::varchar(2),
    ALTER COLUMN state SET NOT NULL;
END $$;

COMMIT;
