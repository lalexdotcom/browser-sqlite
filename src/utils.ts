export const sqlParams = () => {
	const sqlParamsMap = new Map<any, number>();
	const sqlParams: any[] = [];

	const addParam = (v: any) => {
		let paramIndex = sqlParamsMap.get(v);
		if (!paramIndex) {
			sqlParamsMap.set(v, (paramIndex = sqlParams.length + 1));
			sqlParams.push(v);
		}
		return `?${paramIndex.toString().padStart(3, '0')}`;
	};
	const addParamArray = (values: any[]) => {
		return values.map((v) => addParam(v)).join(',');
	};
	return {
		addParam,
		addParamArray,
		params: sqlParams,
	};
};

export const isWriteQuery = (sql: string) => {
	return /(INSERT|REPLACE|UPDATE|DELETE|CREATE|DROP)\s/gim.test(sql);
};
