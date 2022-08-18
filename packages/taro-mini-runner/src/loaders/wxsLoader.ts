

import { transform } from 'babel-core'

export default function (source) {
    let result = transform(source, {
        presets: [['env', {
            modules: 'commonjs',
            useBuiltIns: 'usage'
        }]],
    });
    return result.code;
};